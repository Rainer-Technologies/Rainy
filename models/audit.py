"""Append-only security audit trail (logins, failures, credential/role changes)."""
import logging

from .database import Database

log = logging.getLogger(__name__)


class AuditModel:
    @staticmethod
    def record(event, user_id=None, target_user_id=None, ip=None, detail=None):
        """Best-effort insert; auditing must never break the request."""
        try:
            Database.execute_query(
                "INSERT INTO audit_events (event, user_id, target_user_id, ip, detail) "
                "VALUES (%s, %s, %s, %s, %s)",
                (event[:64], user_id, target_user_id,
                 (ip or '')[:45] or None, (detail or '')[:500] or None))
        except Exception:
            log.exception('Failed to write audit event %s', event)
