from unittest.mock import patch, MagicMock
from app.sentry import before_send, set_sentry_context

def test_before_send_suppresses_401_404():
    exc_401 = MagicMock()
    exc_401.status_code = 401
    hint_401 = {"exc_info": (Exception, exc_401, None)}
    assert before_send({}, hint_401) is None

    exc_404 = MagicMock()
    exc_404.status_code = 404
    hint_404 = {"exc_info": (Exception, exc_404, None)}
    assert before_send({}, hint_404) is None

    exc_500 = MagicMock()
    exc_500.status_code = 500
    hint_500 = {"exc_info": (Exception, exc_500, None)}
    event = {}
    assert before_send(event, hint_500) == event

@patch("app.sentry.sentry_sdk")
def test_set_sentry_context(mock_sentry):
    set_sentry_context(ledger_sequence=12345, user_id="user_99", trace_id="trace_abc")
    mock_sentry.set_tag.assert_any_call("ledger_sequence", "12345")
    mock_sentry.set_tag.assert_any_call("user_id", "user_99")
    mock_sentry.set_tag.assert_any_call("trace_id", "trace_abc")
    mock_sentry.set_user.assert_called_once_with({"id": "user_99"})
