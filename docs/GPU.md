# GPU acceleration for light show analysis

Rainy's light show analysis (`utils/lightshow_analyzer.py`) can use an NVIDIA GPU
for its most expensive step, harmonic/percussive separation (about two thirds of
the analysis time). The GPU is an **optional** speed-up:

- No GPU, no `torch`, or an unusable GPU: analysis runs on the CPU, multi-threaded.
- Scores are identical on every path (the GPU and CPU results are bit-compatible
  with the original librosa implementation).

Implementation: `utils/lightshow_accel.py`.

## How the device is chosen

At first use Rainy probes each visible CUDA GPU and logs the outcome once:

```
[lightshow-accel] analysis device: cuda:0 (NVIDIA GeForce RTX 4060 Ti)
[lightshow-accel] analysis device: cpu (CPU x8 threads) — no CUDA GPU visible to PyTorch
```

A GPU is used only if it passes both checks:

1. **Architecture check.** The installed PyTorch build must ship kernels for the
   GPU's compute capability (`torch.cuda.get_arch_list()`). "CUDA is available"
   is not enough on its own.
2. **Self-test.** HPSS is run on a small probe array on the GPU and compared with
   the CPU result. A GPU that loads but fails or returns different numbers is skipped.

If several GPUs pass, the one with the most memory is used. At runtime, an
out-of-memory error falls back to CPU for that track only; any other GPU error
turns the GPU off for the rest of the process. Either way analysis continues.

## Setup (any NVIDIA GPU)

1. Install a recent NVIDIA driver. No system CUDA toolkit is needed: the PyTorch
   wheel bundles the CUDA runtime.
2. Install a **CUDA build** of PyTorch into the same virtualenv that runs Rainy:

   ```sh
   pip install torch --index-url https://download.pytorch.org/whl/cu126
   ```

   On Windows a plain `pip install torch` installs the CPU-only build, so use the
   command above.
3. Verify:

   ```sh
   python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0), torch.cuda.get_arch_list())"
   ```

4. Start Rainy and check the log for the `analysis device:` line.

## Tesla V100 (and other Volta GPUs)

A V100 is compute capability **7.0 (`sm_70`)**. Some newer PyTorch CUDA builds
have dropped Volta kernels, in which case the V100 is not usable even though
`torch.cuda.is_available()` is `True`. Rainy detects this and falls back to CPU
instead of failing, but to actually get the speed-up:

- Use a PyTorch build that still lists `sm_70` in `torch.cuda.get_arch_list()`.
  The `cu126` build (torch 2.14.1+cu126, tested arch list `sm_50 … sm_70 … sm_90`)
  does. If a later release drops it, pin an older torch or use the `cu118` index
  (`https://download.pytorch.org/whl/cu118`).
- The driver must support the CUDA version of the wheel. Check the "CUDA Version"
  in the `nvidia-smi` header (12.6+ for `cu126`); on an older driver use `cu118`
  or update the driver.
- Confirm the verify command above prints the V100 name, `(7, 0)`, and `sm_70`
  in the arch list.

If the V100 is rejected, the log says why, for example:

```
[lightshow-accel] cuda:0 not usable: Tesla V100-SXM2-16GB is sm_70 but this PyTorch build only has sm_75,sm_80,... Tesla V100 is sm_70; install a PyTorch build that still ships Volta kernels (...)
```

Status: the GPU path was tested end to end on an RTX 4060 Ti (`sm_89`) with
results identical to CPU. The V100 handling (architecture check and self-test)
follows the same code path but has **not** been run on real V100 hardware; the
startup log line is the authoritative confirmation.

## Docker

`compose.yaml` already reserves all NVIDIA GPUs for the `app` service, which
needs the NVIDIA Container Toolkit on the host. The image does **not** include
`torch` by default, so add a CUDA build to the image (for example
`pip install torch --index-url https://download.pytorch.org/whl/cu126` in the
Dockerfile) to use the GPU; without it Rainy uses the CPU. On a host without
the toolkit, remove the `deploy:` block from `compose.yaml`.

## CPU-only servers

Nothing to install. The CPU path splits the median filters across cores and is
roughly 3× faster end to end than the original single-threaded code (8.3 s → 2.8 s
on a 216 s track, Ryzen 5 5600X). Gains scale with core count, so 1–2 core
machines benefit less.

## Configuration

Set in `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RAINY_LIGHTSHOW_DEVICE` | `auto` | `auto`, `cpu` (never use the GPU), `cuda` (first usable GPU), or `cuda:N` (a specific GPU) |
| `RAINY_LIGHTSHOW_THREADS` | cores, max 8 | CPU worker threads for the CPU path |

## Troubleshooting

| Log message | Cause / fix |
| --- | --- |
| `no CUDA GPU visible to PyTorch` | CPU-only torch, driver missing/too old, or no container GPU access |
| `PyTorch unavailable` | `torch` not installed (optional) |
| `… is sm_XX but this PyTorch build only has …` | The torch build lacks kernels for that GPU; install a build that lists its `sm_XX` |
| `failed the self-test` | Kernel or driver problem on that GPU; update the driver or try another torch build |
| `GPU out of memory on this track` | Very long track; that track used CPU. Nothing to do |
