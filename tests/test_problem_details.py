"""Regression tests for the FastAPI RFC 7807 exception contract."""

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError

from app.problem_details import register_problem_handlers


def _client() -> TestClient:
    app = FastAPI()
    register_problem_handlers(app)

    @app.get("/missing")
    async def missing():
        raise HTTPException(status_code=404, detail="Record not found")

    @app.get("/database-error")
    async def database_error():
        raise SQLAlchemyError("sensitive database connection string")

    @app.get("/unexpected-error")
    async def unexpected_error():
        raise RuntimeError("sensitive implementation detail")

    @app.get("/items/{item_id}")
    async def item(item_id: int):
        return {"item_id": item_id}

    return TestClient(app, raise_server_exceptions=False)


def test_http_errors_use_problem_details_and_keep_safe_client_detail():
    response = _client().get("/missing")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json() == {
        "type": "about:blank",
        "title": "Not Found",
        "status": 404,
        "detail": "Record not found",
        "instance": "/missing",
    }


def test_validation_errors_use_the_same_problem_shape():
    response = _client().get("/items/not-an-integer")

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json() == {
        "type": "about:blank",
        "title": "Request validation failed",
        "status": 422,
        "detail": "One or more request fields are invalid.",
        "instance": "/items/not-an-integer",
    }


def test_database_errors_are_normalized_without_leaking_driver_details():
    response = _client().get("/database-error")

    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "sensitive database connection string" not in response.text
    assert response.json()["detail"] == "A database operation failed."


def test_unhandled_errors_are_normalized_without_leaking_exception_text():
    response = _client().get("/unexpected-error")

    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/problem+json")
    assert "sensitive implementation detail" not in response.text
    assert response.json()["instance"] == "/unexpected-error"
