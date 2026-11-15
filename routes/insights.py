from flask import Blueprint, request, jsonify
from functools import wraps
from datetime import date

from routes.auth import get_current_user_id
from utils import insights

insights_bp = Blueprint('insights', __name__, url_prefix='/api/insights')


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({'error': 'Authentication required'}), 401
        return f(user_id, *args, **kwargs)
    return decorated


@insights_bp.route('/summary', methods=['GET'])
@login_required
def summary(user_id):
    """Insights payload. Optional `dates` (comma-separated YYYY-MM-DD) filters
    the overview/clock/tops/trend to those days; the calendar and streak stay
    full-history."""
    raw = request.args.get('dates', '')
    selected = None
    if raw:
        selected = set()
        for part in raw.split(','):
            part = part.strip()
            if not part:
                continue
            try:
                selected.add(date.fromisoformat(part))
            except ValueError:
                return jsonify({'error': 'dates must be comma-separated YYYY-MM-DD'}), 400
        if len(selected) > 400:
            return jsonify({'error': 'too many dates selected'}), 400
    return jsonify(insights.build_insights(user_id, selected=selected or None))


@insights_bp.route('/wrapped', methods=['GET'])
@login_required
def wrapped(user_id):
    """A year-in-review card. Defaults to the current year."""
    year = request.args.get('year', type=int) or date.today().year
    if not (1970 <= year <= 2100):
        return jsonify({'error': 'invalid year'}), 400
    return jsonify(insights.build_wrapped(user_id, year))


@insights_bp.route('/day', methods=['GET'])
@login_required
def day(user_id):
    """One day's listening detail (hourly clock, totals, tops, listens)."""
    raw = request.args.get('date', '')
    try:
        d = date.fromisoformat(raw)
    except ValueError:
        return jsonify({'error': 'date must be YYYY-MM-DD'}), 400
    return jsonify(insights.build_day(user_id, d))