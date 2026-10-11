#!/usr/bin/env python3
"""Pack a light show environment into the zip a Rainy server installs.

    python scripts/pack_environment.py packages/voyage            -> dist/voyage-1.0.0.zip
    python scripts/pack_environment.py my-environment -o builds

The folder is checked exactly as the server checks an upload, so a package
that packs here installs there. Hidden files and the folder's ``tests/`` are
left out. See docs/ENVIRONMENTS.md.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

from utils.environments import PackageError, pack_directory, package_digest  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('directory', help='folder holding rainy-environment.json')
    parser.add_argument('-o', '--out', default='dist', help='where the zip goes (default: dist)')
    args = parser.parse_args()

    if not os.path.isdir(args.directory):
        sys.exit(f'{args.directory} is not a folder')
    try:
        manifest, data = pack_directory(args.directory)
    except PackageError as e:
        sys.exit(f'Not packed: {e}')
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"{manifest['id']}-{manifest['version']}.zip")
    with open(path, 'wb') as fh:
        fh.write(data)
    print(f"{path}  {len(data) / 1024:.0f} KB  sha256:{package_digest(data)[:16]}")
    print(f"{manifest['name']} {manifest['version']} (id {manifest['id']}, API {manifest['api']}, layout {manifest['layout']})")
    if not manifest.get('preview'):
        print('Note: no "preview" picture. Add one (16:9) so people can tell the environment apart when they pick it.')


if __name__ == '__main__':
    main()
