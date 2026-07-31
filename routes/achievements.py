from flask import Blueprint, jsonify
from functools import wraps
from models.achievement import AchievementModel
from routes.auth import get_current_user_id

achievements_bp = Blueprint('achievements', __name__, url_prefix='/api/achievements')


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user_id = get_current_user_id()
        if user_id is None:
            return jsonify({'error': 'Authentication required'}), 401
        return f(user_id, *args, **kwargs)
    return decorated


@achievements_bp.route('', methods=['GET'])
@login_required
def get_achievements(user_id):
    """Get all achievements with progress and unlock status."""
    achievements = AchievementModel.get_all_with_progress(user_id)
    summary = AchievementModel.get_summary(user_id)
    return jsonify({
        'achievements': achievements,
        'summary': summary,
    })


@achievements_bp.route('/evaluate', methods=['POST'])
@login_required
def evaluate_achievements(user_id):
    """Force a full re-evaluation of all achievements (e.g. after bulk import)."""
    newly = AchievementModel.evaluate(user_id)
    return jsonify({
        'newly_unlocked': newly,
        'count': len(newly),
    })


@achievements_bp.route('/summary', methods=['GET'])
@login_required
def get_summary(user_id):
    """Quick summary: how many unlocked out of total."""
    return jsonify(AchievementModel.get_summary(user_id))
