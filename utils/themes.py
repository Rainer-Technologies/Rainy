"""UI theme packages.

A theme changes how the whole web interface looks: a zip holding a
``rainy-theme.json`` manifest, design tokens, stylesheets and, optionally, a
module for decorative layers (docs/THEMES.md). It never replaces Rainy's
markup: the app keeps building every button and view, and the theme styles
them through the public contract in static/js/theme/contract.json.

Besides the checks every package gets (utils/packages.py), a theme's
stylesheets are read before it is installed. Whatever a theme does to the
layout, it may not hide or disable Rainy's controls, so declarations that
would (display: none, visibility: hidden, opacity: 0, pointer-events: none
and the like) are refused unless they are aimed at something the theme
itself drew (a pseudo-element, a .theme-* element) or at a part the contract
says may be hidden. !important is refused too: it is how Rainy keeps state
(what is open, which tab is shown) out of a theme's reach.
"""
import json
import os
import re
import sys

from config import Config  # noqa: F401  (tests point its folders elsewhere through this module)
from utils.packages import (  # noqa: F401  (part of this module's interface)
    IMAGE_EXT,
    MIME_TYPES,
    SCRIPT_EXT,
    PackageError,
    PackageKind,
    common_fields,
    file_field,
    mime_type,
    package_digest,
    revision,
)

MANIFEST_NAME = 'rainy-theme.json'
MANIFEST_VERSION = 1

MAX_ZIP_BYTES = 20 * 1024 * 1024
MAX_UNPACKED_BYTES = 60 * 1024 * 1024
MAX_FILES = 500
MAX_STYLESHEET_BYTES = 1024 * 1024

# Rainy's own look.
RESERVED_IDS = {'rainy'}
COLOR_SCHEMES = ('dark', 'light')

_CONTRACT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'static', 'js', 'theme', 'contract.json')


def load_contract():
    with open(_CONTRACT_PATH, encoding='utf-8') as fh:
        return json.load(fh)


CONTRACT = load_contract()
# Versions of the theme contract this server's frontend speaks (THEME_API in static/js/theme/index.js).
API_VERSIONS = (CONTRACT['api'],)
PUBLIC_TOKENS = frozenset(CONTRACT['tokens'])
PARTS = frozenset(p['part'] for p in CONTRACT['parts'])
HIDEABLE_PARTS = frozenset(p['part'] for p in CONTRACT['parts'] if p.get('hideable'))
# Parts that only hold others: a theme may flatten them (display: contents) to lay their children out itself.
CONTAINER_PARTS = frozenset(p['part'] for p in CONTRACT['parts'] if not p.get('control'))
PUBLIC_CLASSES = frozenset(
    name for item in CONTRACT['items'] for name in re.findall(r'\.([\w-]+)', item['selector'])
) | frozenset(CONTRACT.get('stateClasses', [])) | {
    'btn-primary', 'btn-secondary', 'btn-danger', 'icon-btn-small', 'play-pause', 'secondary',
    'modal-header', 'modal-body'}
ICON_NAMES = frozenset(i['name'] for i in CONTRACT.get('icons', []))
MAX_ICON_BYTES = 32 * 1024
PUBLIC_IDS = frozenset(
    name for item in CONTRACT['items'] for name in re.findall(r'#([\w-]+)', item['selector']))

_LANG = re.compile(r'^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$')
_TOKEN_NAME = re.compile(r'^--[a-z][a-z0-9-]{0,63}$')
_BAD_VALUE = re.compile(r'[;{}<>\\]|!\s*important|url\s*\(|expression\s*\(', re.I)


# --------------------------------------------------------------- manifest

def _tokens(data):
    raw = data.get('tokens', {})
    if not isinstance(raw, dict):
        raise PackageError('"tokens" must map token names (like "--accent-primary") to CSS values.')
    if len(raw) > 200:
        raise PackageError('"tokens" may set at most 200 tokens.')
    out = {}
    for name, value in raw.items():
        if not isinstance(name, str) or not _TOKEN_NAME.match(name):
            raise PackageError(f'"{name}" is not a token name: they look like "--accent-primary".')
        if name not in PUBLIC_TOKENS and not name.startswith('--theme-'):
            raise PackageError(f'"{name}" is not one of Rainy\'s tokens (docs/THEMES.md); '
                               'a theme\'s own tokens start with "--theme-".')
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = str(value)
        if not isinstance(value, str) or not value.strip() or len(value) > 200:
            raise PackageError(f'The value of "{name}" must be a CSS value of at most 200 characters.')
        if _BAD_VALUE.search(value):
            raise PackageError(f'The value of "{name}" may not hold ; {{ }} < > \\, url() or !important; '
                               'put images and the like in a stylesheet.')
        out[name] = ' '.join(value.split())
    return out


def _icons(data, files):
    raw = data.get('icons', {})
    if not isinstance(raw, dict):
        raise PackageError('"icons" must map icon names (like "play") to SVG files of the package.')
    if len(raw) > 200:
        raise PackageError('"icons" may replace at most 200 icons.')
    out = {}
    for name, path in raw.items():
        if name not in ICON_NAMES:
            raise PackageError(f'"{name}" is not one of Rainy\'s icons (docs/THEMES.md#icons).')
        out[name] = file_field({'icons': path}, 'icons', files, ('.svg',), required=True)
    return out


def _strings(data):
    raw = data.get('strings', {})
    if not isinstance(raw, dict):
        raise PackageError('"strings" must map a language code to { "English text": "your text" }.')
    out = {}
    for lang, table in raw.items():
        if not isinstance(lang, str) or not _LANG.match(lang) or not isinstance(table, dict):
            raise PackageError('"strings" must map a language code to { "English text": "your text" }.')
        if len(table) > 400:
            raise PackageError(f'"strings" may change at most 400 texts per language ({lang}).')
        words = {}
        for key, value in table.items():
            if not isinstance(key, str) or not key.strip() or len(key) > 300:
                raise PackageError(f'"strings" ({lang}): every key must be one of Rainy\'s English texts.')
            if not isinstance(value, str) or len(value) > 160 or re.search(r'[<>]', value):
                raise PackageError(f'"strings" ({lang}): "{key[:40]}" must become plain text of at most 160 characters.')
            words[key] = value
        if words:
            out[lang] = words
    return out


def validate_manifest(data, files):
    """Check a parsed manifest against the files of its package.

    Returns the manifest as this server stores it: known fields only, in
    their normal form. Raises PackageError with a message for the author.
    """
    common = common_fields(data, 'theme', RESERVED_IDS, API_VERSIONS, MANIFEST_VERSION)
    scheme = data.get('colorScheme', 'dark')
    if scheme not in COLOR_SCHEMES:
        raise PackageError(f'"colorScheme" must be one of: {", ".join(COLOR_SCHEMES)}.')
    styles = data.get('styles', [])
    if not isinstance(styles, list) or len(styles) > 8:
        raise PackageError('"styles" must be a list of at most 8 stylesheets.')
    tokens = _tokens(data)
    styles = [file_field({'styles': s}, 'styles', files, ('.css',), required=True) for s in styles]
    icons = _icons(data, files)
    strings = _strings(data)
    if not tokens and not styles and not icons and not strings:
        raise PackageError('A theme needs tokens, styles, icons or strings: it would not change anything.')
    return {
        **{k: common[k] for k in ('manifest', 'api', 'id', 'name', 'version', 'description',
                                   'author', 'license', 'homepage')},
        'colorScheme': scheme,
        'tokens': tokens,
        'styles': styles,
        'icons': icons,
        'strings': strings,
        'entry': file_field(data, 'entry', files, SCRIPT_EXT),
        'preview': file_field(data, 'preview', files, IMAGE_EXT),
        'i18n': common['i18n'],
    }


# ------------------------------------------------------------------- CSS

class _Css:
    """Just enough of a CSS reader: rules, at-rules and declarations, with nesting.

    Comments are dropped and strings kept whole, so braces and semicolons
    inside them do not count.
    """

    def __init__(self, text):
        self.text = re.sub(r'/\*.*?\*/', ' ', text, flags=re.S)
        self.i = 0

    def _read_until(self, stops):
        """Text up to (not including) the first character in ``stops`` outside strings and parentheses."""
        out, depth, n, t = [], 0, len(self.text), self.text
        while self.i < n:
            c = t[self.i]
            if c in '"\'':
                j = self.i + 1
                while j < n and t[j] != c:
                    j += 2 if t[j] == '\\' else 1
                out.append(t[self.i:j + 1])
                self.i = j + 1
                continue
            if c == '(':
                depth += 1
            elif c == ')':
                depth = max(0, depth - 1)
            elif depth == 0 and c in stops:
                break
            out.append(c)
            self.i += 1
        return ''.join(out)

    def block(self):
        """The items of a block (or of the whole sheet), as a list of
        ('decl', prop, value) | ('rule', prelude, items) | ('at', name, prelude, items|None)."""
        items, n = [], len(self.text)
        while self.i < n:
            chunk = self._read_until('{};')
            stop = self.text[self.i] if self.i < n else ''
            self.i += 1
            head = chunk.strip()
            if stop == '}':
                if head:
                    items.append(self._decl(head))
                return items
            if stop == '{':
                inner = self.block()
                if head.startswith('@'):
                    name, _, prelude = head[1:].partition(' ')
                    items.append(('at', name.lower(), prelude.strip(), inner))
                else:
                    items.append(('rule', head, inner))
            elif head:
                if head.startswith('@'):
                    name, _, prelude = head[1:].partition(' ')
                    items.append(('at', name.lower(), prelude.strip(), None))
                else:
                    items.append(self._decl(head))
        return items

    @staticmethod
    def _decl(text):
        prop, _, value = text.partition(':')
        return ('decl', prop.strip().lower(), value.strip())


def _split_selectors(prelude):
    out, depth, cur = [], 0, []
    for c in prelude:
        if c in '([':
            depth += 1
        elif c in ')]':
            depth -= 1
        if c == ',' and depth == 0:
            out.append(''.join(cur).strip())
            cur = []
        else:
            cur.append(c)
    out.append(''.join(cur).strip())
    return [s for s in out if s]


def _rightmost(selector):
    """The last compound of a selector (what it actually styles)."""
    depth, last = 0, 0
    for i, c in enumerate(selector):
        if c in '([':
            depth += 1
        elif c in ')]':
            depth -= 1
        elif depth == 0 and c in ' >+~':
            last = i + 1
    return selector[last:].strip()


def _parts_named(compound):
    return set(re.findall(r'\[\s*data-part\s*[~|^*$]?=\s*["\']?([\w-]+)', compound))


def _may_hide(selector, prop='', value=''):
    """Whether hiding what this selector selects (with this declaration) is allowed."""
    if '#rainy-theme-layer' in selector:   # everything in the theme's own layers is the theme's
        return True
    compound = _rightmost(selector)
    if prop == 'display' and ' '.join(value.lower().split()) == 'contents':
        # Flattening a region keeps everything in it on screen, laid out by its grandparent.
        parts = _parts_named(compound)
        if parts and parts <= CONTAINER_PARTS and not re.search(r'[.#]', re.sub(r'\[[^\]]*\]', '', compound)):
            return True
    if '::' in compound or re.search(r':(before|after|placeholder|first-line|first-letter|marker|selection)\b', compound):
        return True
    if re.search(r'\.theme-[\w-]+', compound):
        return True
    parts = _parts_named(compound)
    return bool(parts) and parts <= HIDEABLE_PARTS


def _hiding(prop, value):
    v = ' '.join(value.lower().split())
    if prop == 'display':
        return v in ('none', 'contents')
    if prop == 'visibility':
        return v in ('hidden', 'collapse')
    if prop == 'opacity':
        try:
            return float(v.rstrip('%')) == 0
        except ValueError:
            return False
    if prop == 'content-visibility':
        return v == 'hidden'
    if prop == 'font-size':
        return re.fullmatch(r'0+(\.0+)?(px|em|rem|%)?', v) is not None
    if prop == 'pointer-events':
        return v == 'none'
    return False


def _external(url):
    u = url.strip().strip('"\'').strip()
    if u.startswith('//'):
        return True
    m = re.match(r'^([a-z][a-z0-9+.-]*):', u, re.I)
    return bool(m) and m.group(1).lower() != 'data'


def lint_css(text, path='style.css'):
    """Check a theme's stylesheet. Returns (errors, warnings), lists of messages."""
    errors, warnings = [], []
    if re.search(r'!\s*important', re.sub(r'/\*.*?\*/', '', text, flags=re.S), re.I):
        errors.append(f'{path}: !important is not allowed in a theme (it would beat Rainy\'s own state rules).')
    for url in re.findall(r'url\(\s*([^)]*)\)', text, re.I):
        if _external(url):
            errors.append(f'{path}: url({url.strip()}) loads from elsewhere; carry the file in the package.')
    unknown_parts, internal = set(), set()

    def selectors_of(prelude, parents):
        own = _split_selectors(prelude)
        if not parents:
            return own
        out = []
        for sel in own:
            for parent in parents:
                out.append(sel.replace('&', parent) if '&' in sel else f'{parent} {sel}')
        return out

    def walk(items, selectors, in_keyframes=False):
        for item in items:
            kind = item[0]
            if kind == 'decl':
                _k, prop, value = item
                if not selectors or in_keyframes or not _hiding(prop, value):
                    continue
                for sel in selectors:
                    if not _may_hide(sel, prop, value):
                        errors.append(f'{path}: "{prop}: {value}" on {sel} could hide Rainy\'s controls. '
                                      'A theme may hide only what it draws itself (pseudo-elements, .theme-* '
                                      'elements) and the parts marked hideable in docs/THEMES.md.')
            elif kind == 'rule':
                _k, prelude, inner = item
                sels = selectors_of(prelude, selectors)
                for sel in _split_selectors(prelude):
                    unknown_parts.update(_parts_named(sel) - PARTS)
                    if '#rainy-theme-layer' in sel:   # the theme's own drawings: its own names
                        continue
                    for cls in re.findall(r'\.([\w-]+)', sel):
                        if not cls.startswith('theme-') and cls not in PUBLIC_CLASSES:
                            internal.add('.' + cls)
                    for ident in re.findall(r'#([\w-]+)', sel):
                        if ident not in PUBLIC_IDS:
                            internal.add('#' + ident)
                walk(inner, sels, in_keyframes)
            else:
                _k, name, prelude, inner = item
                if name == 'import':
                    errors.append(f'{path}: @import is not allowed; list every stylesheet under "styles".')
                if inner is not None:
                    walk(inner, selectors, in_keyframes or name.endswith('keyframes'))

    try:
        walk(_Css(text).block(), [])
    except RecursionError:
        errors.append(f'{path}: the stylesheet nests too deeply.')
    if unknown_parts:
        warnings.append(f'{path}: these parts do not exist (typo, or a newer Rainy?): '
                        + ', '.join(sorted(unknown_parts)))
    if internal:
        shown = sorted(internal)
        more = f' and {len(shown) - 12} more' if len(shown) > 12 else ''
        warnings.append(f'{path}: styles internal names that may change without notice: '
                        + ', '.join(shown[:12]) + more + '. Prefer the parts and classes in docs/THEMES.md.')
    return errors, warnings


_SVG_REFUSED = re.compile(
    r'<\s*(script|foreignObject|image|iframe|object|embed|style|use|a|animate\w*|set)\b'
    r'|\son\w+\s*=|(?:xlink:)?href\s*=\s*["\'](?!#)|javascript:|<!ENTITY|<!DOCTYPE',
    re.I)


def check_svg(raw, path):
    """Errors in an icon file: it must be a small, plain SVG of shapes."""
    if len(raw) > MAX_ICON_BYTES:
        return [f'{path} is larger than {MAX_ICON_BYTES // 1024} KB.']
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        return [f'{path} is not UTF-8 text.']
    if not re.search(r'<svg\b', text):
        return [f'{path} is not an SVG.']
    found = _SVG_REFUSED.search(text)
    if found:
        return [f'{path} holds "{found.group(0).strip()}": an icon may only hold shapes (path, circle, rect…).']
    return []


def inspect(manifest, read):
    """Lint every stylesheet and icon of a theme; raises PackageError for what may not be installed."""
    errors, warnings = [], []
    for path in sorted(set(manifest.get('icons', {}).values())):
        errors += check_svg(read(path), path)
    for path in manifest['styles']:
        raw = read(path)
        if len(raw) > MAX_STYLESHEET_BYTES:
            errors.append(f'{path} is larger than {MAX_STYLESHEET_BYTES // 1024} KB.')
            continue
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            errors.append(f'{path} is not UTF-8 text.')
            continue
        e, w = lint_css(text, path)
        errors += e
        warnings += w
    if errors:
        shown = errors[:8]
        more = f'\n…and {len(errors) - 8} more.' if len(errors) > 8 else ''
        raise PackageError('The theme\'s styles break the rules for themes:\n' + '\n'.join(shown) + more)
    return warnings


KIND = PackageKind(
    label='theme',
    manifest_name=MANIFEST_NAME,
    validate=lambda data, files: validate_manifest(data, files),
    inspect=lambda manifest, read: inspect(manifest, read),
    limits=sys.modules[__name__],
    cache_attr='THEMES_CACHE_DIR',
    dev_attr='THEMES_DEV_DIR',
)

read_package = KIND.read_package
extract_package = KIND.extract_package
read_directory = KIND.read_directory
pack_directory = KIND.pack_directory
cache_dir = KIND.cache_dir
ensure_unpacked = KIND.ensure_unpacked
prune_cache = KIND.prune_cache
dev_packages = KIND.dev_packages
