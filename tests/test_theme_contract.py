"""The public surface UI themes build on (static/js/theme/contract.json, docs/THEMES.md).

A theme styles Rainy through its parts, states and tokens; these tests keep
the app and the contract in step, so a change to the app cannot silently
break the themes people installed, and so whatever the app adds lands where
themes reach it:

- every part the contract lists is still in the page, and no part is in the
  page without being listed;
- every control on the page sits inside a part, so a button added later is
  styled by the theme of the region it lands in;
- the classes of what the app builds in JavaScript are still built;
- the cascade layers that let themes win over Rainy, and the guard rules no
  theme can undo, are in place;
- ratchets: Rainy's own CSS does not grow new !important rules or hard-coded
  colours, which themes could not override.

No database or server needed.
"""
import json
import os
import re
from html.parser import HTMLParser

import pytest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
STATIC = os.path.join(ROOT, 'static')
CSS = os.path.join(STATIC, 'css')

# Parts that hold the others: a control directly inside one of these is not in a region of its own.
ROOT_PARTS = {'app', 'app-body'}
INTERACTIVE = {'button', 'a', 'input', 'select', 'textarea'}
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}

# Baselines of what Rainy's own CSS may not grow (lower them as the CSS improves).
MAX_CORE_IMPORTANT = 12
MAX_CORE_COLOUR_LITERALS = 71


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding='utf-8') as fh:
        return fh.read()


@pytest.fixture(scope='module')
def contract():
    return json.loads(read('static', 'js', 'theme', 'contract.json'))


class _Page(HTMLParser):
    """index.html as a list of elements with their attributes and the parts around them."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []      # (tag, attrs)
        self.elements = []   # (tag, attrs, [parts of ancestors, nearest last], line)

    def _parts_above(self):
        out = []
        for _tag, attrs in self.stack:
            out.extend((attrs.get('data-part') or '').split())
        return out

    def handle_starttag(self, tag, attrs):
        attrs = {k: (v or '') for k, v in attrs}
        self.elements.append((tag, attrs, self._parts_above(), self.getpos()[0]))
        if tag not in VOID:
            self.stack.append((tag, attrs))

    def handle_startendtag(self, tag, attrs):
        attrs = {k: (v or '') for k, v in attrs}
        self.elements.append((tag, attrs, self._parts_above(), self.getpos()[0]))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return


@pytest.fixture(scope='module')
def page():
    p = _Page()
    p.feed(read('static', 'index.html'))
    return p.elements


def _page_parts(page):
    found = {}
    for tag, attrs, _above, line in page:
        for part in (attrs.get('data-part') or '').split():
            found.setdefault(part, []).append(line)
    return found


def test_every_listed_part_is_in_the_page(contract, page):
    found = _page_parts(page)
    missing = [p['part'] for p in contract['parts'] if p.get('static') and p['part'] not in found]
    assert not missing, f'Parts themes rely on are gone from index.html: {missing}'


def test_every_part_in_the_page_is_listed(contract, page):
    listed = {p['part'] for p in contract['parts']}
    unlisted = sorted(set(_page_parts(page)) - listed)
    assert not unlisted, f'Add these parts to static/js/theme/contract.json (and docs/THEMES.md): {unlisted}'


def test_parts_and_items_have_unique_names(contract):
    names = [p['part'] for p in contract['parts']] + [i['part'] for i in contract['items']]
    assert len(names) == len(set(names))
    for p in contract['parts']:
        assert p['selector'] == f'[data-part~="{p["part"]}"]'


def _is_control(tag, attrs):
    if tag == 'input':
        return attrs.get('type') != 'hidden'
    if tag == 'a':
        return 'href' in attrs
    if tag in INTERACTIVE:
        return True
    if attrs.get('role') in ('button', 'tab', 'menuitem', 'radio', 'checkbox', 'switch', 'option'):
        return True
    tabindex = attrs.get('tabindex')
    return tabindex is not None and tabindex.lstrip('-').isdigit() and int(tabindex) >= 0


def test_every_control_is_inside_a_region(page):
    """A control outside every part would be one no theme knows how to place."""
    stray = []
    for tag, attrs, above, line in page:
        if not _is_control(tag, attrs):
            continue
        own = (attrs.get('data-part') or '').split()
        if not [p for p in above + own if p not in ROOT_PARTS]:
            stray.append(f'line {line}: <{tag} id="{attrs.get("id", "")}" class="{attrs.get("class", "")}">')
    assert not stray, ('These controls are not inside any data-part region; put them in one, '
                       'or give their new region a part (contract.json):\n' + '\n'.join(stray))


def test_the_way_back_to_the_theme_picker_is_marked(page):
    escape = [attrs.get('id') or attrs.get('class') for _t, attrs, _a, _l in page
              if 'theme-escape' in (attrs.get('data-part') or '').split()]
    # The account menu's trigger, its Settings entry and the theme picker in Appearance.
    assert len(escape) >= 3, escape


@pytest.mark.parametrize('kind', ['items'])
def test_built_items_are_still_built(contract, kind):
    for item in contract[kind]:
        classes = re.findall(r'\.([\w-]+)', item['selector'])
        assert classes, item
        token = classes[-1]
        for source in item['sources']:
            text = read(*source.split('/'))
            assert re.search(rf'(?<![\w-]){re.escape(token)}(?![\w-])', text), \
                f'{source} no longer uses .{token} ({item["part"]}): update the contract or keep the class'


def test_tokens_match_the_variables(contract):
    css = read('static', 'css', 'variables.css')
    defined = set(re.findall(r'^\s*(--[\w-]+)\s*:', css, re.M)) - {'--accent-primary-rgb'}
    listed = set(contract['tokens'])
    assert listed <= defined, f'Listed tokens that variables.css no longer defines: {sorted(listed - defined)}'
    assert defined <= listed, f'New tokens: list them in contract.json and docs/THEMES.md: {sorted(defined - listed)}'


def test_states_are_documented(contract):
    names = {s['name'] for s in contract['states']}
    bridge = read('static', 'js', 'theme', 'state.js')
    for name in re.findall(r"put\('(\w+)'", bridge):
        if name == 'track':
            continue
        attr = 'data-' + re.sub(r'[A-Z]', lambda m: '-' + m.group(0).lower(), name)
        assert attr in names, f'state.js sets {attr}, which contract.json does not list'


# ------------------------------------------------------------- cascade layers

def test_core_css_is_layered():
    style = read('static', 'css', 'style.css')
    body = re.sub(r'/\*.*?\*/', '', style, flags=re.S)
    assert re.search(r'^\s*@layer guard, rainy, theme;', body)
    imports = re.findall(r"@import url\('([^']+)'\)\s*(layer\((\w+)\))?;", body)
    assert imports
    for path, _layer, name in imports:
        expected = 'guard' if path.endswith('guard.css') else 'rainy'
        assert name == expected, f'{path} must be imported into layer({expected})'


def test_layer_order_is_the_first_thing_in_head():
    html = read('static', 'index.html')
    head = html.split('<head>', 1)[1]
    first_tag = re.search(r'<(\w+)[^>]*>([^<]*)', re.sub(r'<!--.*?-->', '', head, flags=re.S))
    assert first_tag.group(1) == 'style' and '@layer guard, rainy, theme;' in first_tag.group(2)


def test_guard_keeps_hidden_hidden():
    guard = read('static', 'css', 'guard.css')
    assert re.search(r'\.hidden,\s*\[hidden\]\s*\{\s*display:\s*none !important;', guard)
    base = read('static', 'css', 'base.css')
    assert not re.search(r'^\.hidden\s*\{', base, re.M), '.hidden belongs in guard.css, out of themes\' reach'


def _core_css_files():
    out = [os.path.join(CSS, 'base.css')]
    for folder in ('components', 'pages'):
        out += sorted(os.path.join(CSS, folder, f) for f in os.listdir(os.path.join(CSS, folder)) if f.endswith('.css'))
    return out


def test_core_css_does_not_grow_important_rules():
    count = sum(len(re.findall(r'!important', re.sub(r'/\*.*?\*/', '', open(f).read(), flags=re.S)))
                for f in _core_css_files())
    assert count <= MAX_CORE_IMPORTANT, (
        f'{count} !important rules in Rainy\'s CSS (at most {MAX_CORE_IMPORTANT}): a theme cannot override them. '
        'Raise the selector\'s specificity instead, or put a true invariant in guard.css.')


def test_core_css_does_not_grow_colour_literals():
    count = 0
    for f in _core_css_files():
        if f.endswith('fullscreen.css'):   # the full player is a dark stage over the album art
            continue
        text = re.sub(r'/\*.*?\*/', '', open(f).read(), flags=re.S)
        count += len(re.findall(r'#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d', text))
    assert count <= MAX_CORE_COLOUR_LITERALS, (
        f'{count} hard-coded colours in Rainy\'s CSS (at most {MAX_CORE_COLOUR_LITERALS}). '
        'Use the tokens in variables.css (color-mix(in srgb, var(--text-primary) 10%, transparent) for a tint), '
        'so themes can change them.')


def test_service_worker_assets_exist():
    sw = read('static', 'sw.js')
    assets = re.search(r'SHELL_ASSETS = \[(.*?)\];', sw, re.S).group(1)
    for path in re.findall(r"'(/[^']*)'", assets):
        if path == '/':
            continue
        assert os.path.isfile(os.path.join(STATIC, path.lstrip('/'))), f'sw.js caches {path}, which does not exist'
