"""Data access for installed light show environment packages."""
from .package_store import PackageStore


class EnvironmentModel(PackageStore):
    """CRUD for `lightshow_environments`. Listings never carry the package itself."""

    TABLE = 'lightshow_environments'
