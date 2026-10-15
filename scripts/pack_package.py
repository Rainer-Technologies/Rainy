#!/usr/bin/env python3
"""Pack a Rainy package (a light show environment or a UI theme) into the zip a server installs.

    python scripts/pack_package.py packages/encore           -> dist/encore-1.0.0.zip
    python scripts/pack_package.py packages/voyage -o builds

The kind comes from the manifest in the folder (rainy-theme.json or
rainy-environment.json), and the folder is checked exactly as the server
checks an upload, so a package that packs here installs there. Hidden files
and the folder's ``tests/`` are left out. See docs/THEMES.md and
docs/ENVIRONMENTS.md.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

from utils import environments, themes  # noqa: E402
from utils.packages import PackageError, package_digest  # noqa: E402

KINDS = (themes, environments)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('directory', help='folder holding the manifest')
    parser.add_argument('-o', '--out', default='dist', help='where the zip goes (default: dist)')
    args = parser.parse_args()

    if not os.path.isdir(args.directory):
        sys.exit(f'{args.directory} is not a folder')
    kind = next((k for k in KINDS if os.path.isfile(os.path.join(args.directory, k.MANIFEST_NAME))), None)
    if not kind:
        sys.exit(f'{args.directory} has no {" or ".join(k.MANIFEST_NAME for k in KINDS)}')
    warnings = []
    try:
        manifest, data = kind.pack_directory(args.directory, warnings=warnings)
    except PackageError as e:
        sys.exit(f'Not packed: {e}')
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"{manifest['id']}-{manifest['version']}.zip")
    with open(path, 'wb') as fh:
        fh.write(data)
    print(f"{path}  {len(data) / 1024:.0f} KB  sha256:{package_digest(data)[:16]}")
    print(f"{manifest['name']} {manifest['version']} ({kind.KIND.label} {manifest['id']}, API {manifest['api']})")
    for warning in warnings:
        print(f'Warning: {warning}')
    if not manifest.get('preview'):
        print(f'Note: no "preview" picture. Add one (16:9) so people can tell the {kind.KIND.label} apart when they pick it.')


if __name__ == '__main__':
    main()
