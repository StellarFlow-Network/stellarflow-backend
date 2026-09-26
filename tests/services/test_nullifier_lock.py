import pytest

from app.services.nullifier_lock import LockAcquireTimeout, NullifierTreeLock


@pytest.mark.asyncio
async def test_release_is_safe_when_not_owned():
    class FakeRedis:
        async def eval(self, *args):
            raise AssertionError("release must not call Redis without a token")

    lock = NullifierTreeLock(FakeRedis(), "test")
    await lock.release()


@pytest.mark.asyncio
async def test_lock_timeout_is_explicit():
    class FakeRedis:
        async def set(self, *args, **kwargs):
            return False

    lock = NullifierTreeLock(
        FakeRedis(),
        "test",
    )
    with pytest.raises(LockAcquireTimeout):
        await lock.acquire()
