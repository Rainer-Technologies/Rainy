"""Acceleration for the light show analyser: harmonic/percussive separation.

HPSS is ~2/3 of the analysis time (two large median filters + soft masks), so
that is the only step with an accelerated path. Both paths are bit-compatible
with ``librosa.decompose.hpss(S, kernel_size=...)`` (same filters, same
reflect padding, same soft masks), so scores do not change.

  * GPU (optional): PyTorch on an NVIDIA GPU. Nothing is assumed from "CUDA is
    available" alone — each GPU is checked for kernels built for its compute
    capability (a Tesla V100 is sm_70, which some newer PyTorch CUDA wheels no
    longer ship) and then proves itself by running HPSS on a probe array and
    matching the CPU result. Anything that fails falls back to the CPU path.
  * CPU: the scipy median filters run on all cores (split into independent
    row/column slabs), which is much faster than librosa's single-threaded call.

Environment:
  RAINY_LIGHTSHOW_DEVICE   auto (default) | cpu | cuda | cuda:N
  RAINY_LIGHTSHOW_THREADS  CPU worker threads (default: cores, max 8)
"""
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np

_LOG_PREFIX = '[lightshow-accel]'

_lock = threading.Lock()
_backend = None  # resolved once: {'device': 'cpu'|'cuda:N', 'name': str, 'note': str}
_torch = None


def _log(msg):
    print(f'{_LOG_PREFIX} {msg}', flush=True)


# --------------------------------------------------------------- CPU path

def _cpu_threads():
    try:
        n = int(os.environ.get('RAINY_LIGHTSHOW_THREADS', ''))
        if n > 0:
            return n
    except ValueError:
        pass
    try:
        n = len(os.sched_getaffinity(0))
    except AttributeError:
        n = os.cpu_count() or 1
    return max(1, min(8, n))


def _slabs(n, parts):
    parts = max(1, min(parts, n))
    edges = np.linspace(0, n, parts + 1).astype(int)
    return [(int(a), int(b)) for a, b in zip(edges[:-1], edges[1:]) if b > a]


def _softmask_np(X, X_ref):
    """librosa.util.softmask(X, X_ref, power=2, split_zeros=True), in place-ish."""
    Z = np.maximum(X, X_ref)
    bad = Z < np.finfo(Z.dtype).tiny
    Z[bad] = 1
    m = (X / Z) ** 2
    r = (X_ref / Z) ** 2
    good = ~bad
    m[good] /= m[good] + r[good]
    m[bad] = 0.5
    return m


def _hpss_cpu(S, win_harm, win_perc):
    from scipy.ndimage import median_filter
    threads = _cpu_threads()
    F, T = S.shape
    harm = np.empty_like(S)
    perc = np.empty_like(S)
    H = np.empty_like(S)
    P = np.empty_like(S)

    def run_harm(ab):  # filter spans time only -> frequency rows are independent
        a, b = ab
        harm[a:b] = median_filter(S[a:b], size=(1, win_harm), mode='reflect')

    def run_perc(ab):  # filter spans frequency only -> time columns are independent
        a, b = ab
        perc[:, a:b] = median_filter(S[:, a:b], size=(win_perc, 1), mode='reflect')

    def run_mask(ab):
        a, b = ab
        h, p, s = harm[a:b], perc[a:b], S[a:b]
        H[a:b] = s * _softmask_np(h, p)
        P[a:b] = s * _softmask_np(p, h)

    if threads == 1:
        run_harm((0, F))
        run_perc((0, T))
        run_mask((0, F))
        return H, P
    with ThreadPoolExecutor(threads) as ex:
        list(ex.map(run_harm, _slabs(F, threads)))
        list(ex.map(run_perc, _slabs(T, threads)))
        list(ex.map(run_mask, _slabs(F, threads)))
    return H, P


# --------------------------------------------------------------- GPU path

def _median_last(x, win, budget=1 << 26):
    """Sliding median (odd ``win``) over the last axis of a 2-D CUDA tensor with
    scipy's ``mode='reflect'`` edges; chunked over rows to bound memory."""
    torch = _torch
    n = x.shape[1]
    h = win // 2
    idx = np.arange(-h, n + h)
    idx = np.where(idx < 0, -idx - 1, idx)
    idx = np.where(idx >= n, 2 * n - 1 - idx, idx)
    idx = torch.from_numpy(idx).to(x.device)
    rows = max(1, budget // max(1, n * win))
    out = torch.empty_like(x)
    for a in range(0, x.shape[0], rows):
        xp = x[a:a + rows].index_select(1, idx)
        out[a:a + rows] = xp.unfold(1, win, 1).median(dim=-1).values
    return out


def _softmask_t(X, X_ref):
    torch = _torch
    Z = torch.maximum(X, X_ref)
    bad = Z < torch.finfo(Z.dtype).tiny
    Z = torch.where(bad, torch.ones_like(Z), Z)
    m = (X / Z) ** 2
    r = (X_ref / Z) ** 2
    m = torch.where(bad, torch.full_like(m, 0.5), m / (m + r))
    return m


def _hpss_gpu(S, win_harm, win_perc, device):
    torch = _torch
    with torch.no_grad():
        x = torch.from_numpy(np.ascontiguousarray(S)).to(device)
        harm = _median_last(x, win_harm)
        perc = _median_last(x.t().contiguous(), win_perc).t().contiguous()
        H = (x * _softmask_t(harm, perc)).cpu().numpy()
        P = (x * _softmask_t(perc, harm)).cpu().numpy()
        del x, harm, perc
    return H, P


# ------------------------------------------------------------ GPU selection

def _arch_supported(major, minor, arch_list):
    """True if this torch build ships a cubin (same major, minor >= built) or
    PTX (JIT-able on any >= arch) that can run on compute capability major.minor."""
    for arch in arch_list:
        m = re.fullmatch(r'(sm|compute)_(\d+)', arch)  # skips arch-specific 'sm_90a'
        if not m:
            continue
        num = int(m.group(2))
        amaj, amin = divmod(num, 10)
        if m.group(1) == 'sm' and amaj == major and amin <= minor:
            return True
        if m.group(1) == 'compute' and (amaj, amin) <= (major, minor):
            return True
    return False


def _probe_gpu(index):
    """Return (ok, reason). Runs HPSS on a probe array and compares with the CPU."""
    torch = _torch
    device = f'cuda:{index}'
    try:
        major, minor = torch.cuda.get_device_capability(index)
        name = torch.cuda.get_device_name(index)
    except Exception as e:  # noqa: BLE001
        return False, f'cannot query device ({e})'
    arches = torch.cuda.get_arch_list()
    if not _arch_supported(major, minor, arches):
        hint = ''
        if (major, minor) == (7, 0):
            hint = (' Tesla V100 is sm_70; install a PyTorch build that still ships Volta '
                    'kernels (e.g. the cu126 / cu118 wheels: pip install torch --index-url '
                    'https://download.pytorch.org/whl/cu126)')
        return False, (f'{name} is sm_{major}{minor} but this PyTorch build only has '
                       f'{",".join(arches) or "no CUDA kernels"}.{hint}')
    try:
        rng = np.random.default_rng(3)
        probe = np.abs(rng.standard_normal((257, 420))).astype(np.float32)
        probe[rng.random(probe.shape) < 0.02] = 0.0
        hg, pg = _hpss_gpu(probe, 17, 31, device)
        torch.cuda.synchronize(index)
        hc, pc = _hpss_cpu(probe, 17, 31)
        if not (np.allclose(hg, hc, rtol=1e-4, atol=1e-6) and np.allclose(pg, pc, rtol=1e-4, atol=1e-6)):
            return False, f'{name} produced results that differ from the CPU reference'
    except Exception as e:  # noqa: BLE001
        return False, f'{name} failed the self-test: {str(e).splitlines()[0] if str(e) else type(e).__name__}'
    return True, name


def _select_backend():
    global _torch
    want = (os.environ.get('RAINY_LIGHTSHOW_DEVICE') or 'auto').strip().lower()
    cpu = {'device': 'cpu', 'name': f'CPU x{_cpu_threads()} threads', 'note': ''}
    if want == 'cpu':
        return {**cpu, 'note': 'forced by RAINY_LIGHTSHOW_DEVICE=cpu'}
    try:
        import torch
        _torch = torch
        if not torch.cuda.is_available():
            return {**cpu, 'note': 'no CUDA GPU visible to PyTorch'}
        count = torch.cuda.device_count()
    except Exception as e:  # noqa: BLE001
        return {**cpu, 'note': f'PyTorch unavailable ({type(e).__name__}); pip install torch for GPU speed-up'}

    if want.startswith('cuda:') and want[5:].isdigit():
        candidates = [int(want[5:])]
    else:
        candidates = list(range(count))
    good = []
    for i in candidates:
        if i >= count:
            _log(f'cuda:{i} does not exist ({count} device(s))')
            continue
        ok, info = _probe_gpu(i)
        if ok:
            good.append((torch.cuda.get_device_properties(i).total_memory, i, info))
        else:
            _log(f'cuda:{i} not usable: {info}')
    if not good:
        return {**cpu, 'note': 'no usable GPU, falling back to CPU'}
    _, i, name = max(good)
    return {'device': f'cuda:{i}', 'name': name, 'note': ''}


def get_backend():
    """Resolve (once) which device runs HPSS. Never raises."""
    global _backend
    if _backend is None:
        with _lock:
            if _backend is None:
                try:
                    _backend = _select_backend()
                except Exception as e:  # noqa: BLE001
                    _backend = {'device': 'cpu', 'name': 'CPU', 'note': f'GPU probe failed ({e})'}
                _log(f"analysis device: {_backend['device']} ({_backend['name']})"
                     + (f" — {_backend['note']}" if _backend['note'] else ''))
    return _backend


def _disable_gpu(reason):
    global _backend
    with _lock:
        _backend = {'device': 'cpu', 'name': 'CPU', 'note': reason}
    _log(f'GPU disabled, using CPU: {reason}')


# ------------------------------------------------------------------- public

def hpss(S, kernel_size=(17, 31)):
    """Harmonic/percussive split of a magnitude spectrogram ``S`` (float32 or
    float64, shape (freq, time)); same result as ``librosa.decompose.hpss``."""
    win_harm, win_perc = kernel_size
    S = np.asarray(S)
    if S.dtype != np.float32 or S.shape[1] <= win_harm or S.shape[0] <= win_perc:
        from librosa.decompose import hpss as _librosa_hpss
        return _librosa_hpss(S, kernel_size=kernel_size)
    be = get_backend()
    if be['device'] != 'cpu':
        try:
            return _hpss_gpu(S, win_harm, win_perc, be['device'])
        except Exception as e:  # noqa: BLE001
            try:
                _torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass
            if isinstance(e, getattr(_torch.cuda, 'OutOfMemoryError', ())):
                _log('GPU out of memory on this track, using CPU for it')
            else:
                _disable_gpu(f'{type(e).__name__}: {str(e).splitlines()[0] if str(e) else ""}')
    return _hpss_cpu(S, win_harm, win_perc)
