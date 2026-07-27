"""HTTP client for the independently deployed attribution service."""

from __future__ import annotations

import httpx

from .attribution_service import (
    AttributionRequest,
    AttributionResult,
    AttributionService,
    AttributionServiceError,
)


class RemoteAttributionService(AttributionService):
    def __init__(
        self,
        base_url: str,
        *,
        timeout_seconds: float,
        api_token: str | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_token = api_token
        self._client = httpx.Client(
            timeout=timeout_seconds,
            transport=transport,
        )

    def attribute(self, request: AttributionRequest) -> AttributionResult:
        headers = {"Idempotency-Key": str(request.request_id)}
        if self._api_token:
            headers["Authorization"] = f"Bearer {self._api_token}"
        try:
            response = self._client.post(
                f"{self._base_url}/api/v1/attributions",
                headers=headers,
                json=request.model_dump(mode="json"),
            )
            response.raise_for_status()
            result = AttributionResult.model_validate(response.json())
        except (httpx.HTTPError, ValueError) as exc:
            raise AttributionServiceError("attribution service request failed") from exc
        if result.request_id != request.request_id:
            raise AttributionServiceError("attribution service returned a mismatched request_id")
        return result

    def close(self) -> None:
        self._client.close()
