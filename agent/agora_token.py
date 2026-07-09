import os
import time
import logging
from agora_token_builder import RtcTokenBuilder

logger = logging.getLogger(__name__)

def generate_rtc_token(channel_name: str, uid: int | str, role: int = 1, expire_seconds: int = 3600) -> str:
    """
    Generates an Agora RTC token.
    role: 1 = Publisher (Host), 2 = Subscriber (Audience)
    """
    app_id = os.getenv("AGORA_APP_ID", "").strip()
    app_certificate = os.getenv("AGORA_APP_CERTIFICATE", "").strip()

    if not app_id:
        logger.warning("AGORA_APP_ID is not configured. Token generation skipped.")
        return "dummy_token"

    if not app_certificate:
        logger.warning("AGORA_APP_CERTIFICATE is not configured. Token generation skipped.")
        return "dummy_token"

    current_time = int(time.time())
    privilege_expired_ts = current_time + expire_seconds

    try:
        if isinstance(uid, int) or (isinstance(uid, str) and uid.isdigit()):
            numeric_uid = int(uid)
            token = RtcTokenBuilder.buildTokenWithUid(
                app_id, app_certificate, channel_name, numeric_uid, role, privilege_expired_ts
            )
        else:
            token = RtcTokenBuilder.buildTokenWithUserAccount(
                app_id, app_certificate, channel_name, str(uid), role, privilege_expired_ts
            )
        logger.info("Successfully generated Agora RTC token for channel=%s, uid=%s", channel_name, uid)
        return token
    except Exception as e:
        logger.error("Failed to generate Agora RTC token: %s", e)
        return "error_generating_token"
