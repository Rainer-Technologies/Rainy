"""Data access for installed UI theme packages."""
from .package_store import PackageStore
from .settings import SettingsModel

# The theme a user without a choice of their own gets (an installed theme's
# id; unset means Rainy's own look).
DEFAULT_SETTING = 'ui_theme_default'


class ThemeModel(PackageStore):
    """CRUD for `ui_themes`. Listings never carry the package itself."""

    TABLE = 'ui_themes'

    @staticmethod
    def get_default():
        return SettingsModel.get_setting(DEFAULT_SETTING) or None

    @staticmethod
    def set_default(theme_id):
        SettingsModel.set_setting(DEFAULT_SETTING, theme_id or '')
