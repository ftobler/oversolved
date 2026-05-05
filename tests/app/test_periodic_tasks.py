"""Tests for periodic task scheduler and cron expression handling."""

from datetime import datetime, timedelta
import pytest
from oversolved.periodic_tasks import _cron_next


class TestCronNext:
    """Tests for the _cron_next function edge cases."""

    def test_cron_next_monthly(self):
        """@monthly is not a 5-field expression, should raise ValueError."""
        from_time = datetime(2025, 6, 15, 10, 30, 0)
        with pytest.raises(ValueError):
            _cron_next("@monthly", from_time)

    def test_cron_next_day_of_month(self):
        """0 0 15 * * (15th day of month) is unhandled, falls to tomorrow midnight."""
        from_time = datetime(2025, 6, 10, 10, 30, 0)
        result = _cron_next("0 0 15 * *", from_time)
        expected = (from_time + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        assert result == expected

    def test_cron_next_invalid_expression(self):
        """Invalid cron expressions should raise ValueError."""
        from_time = datetime(2025, 6, 15, 10, 30, 0)

        with pytest.raises(ValueError):
            _cron_next("", from_time)

        with pytest.raises(ValueError):
            _cron_next("0 2", from_time)

        with pytest.raises(ValueError):
            _cron_next("0 2 * * * *", from_time)

    def test_cron_next_midnight_edge(self):
        """Daily at midnight near boundaries should handle correctly."""
        from_time = datetime(2025, 6, 15, 23, 59, 0)
        result = _cron_next("0 0 * * *", from_time)
        expected = (from_time + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        assert result == expected

        from_time = datetime(2025, 6, 15, 0, 0, 0)
        result = _cron_next("0 0 * * *", from_time)
        expected = (from_time + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        assert result == expected
