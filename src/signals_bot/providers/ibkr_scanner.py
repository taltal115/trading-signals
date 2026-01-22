from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class IbkrScannerRequest:
    scan_code: str
    instrument: str = "STK"
    location_code: str = "STK.US.MAJOR"
    number_of_rows: int = 50


class IbkrScannerClient:
    """
    Thin wrapper around IBKR scanner subscriptions.

    Uses ib_insync for simplicity. This repo remains signal-only: we only read data.
    """

    def __init__(self, *, host: str, port: int, client_id: int, connect_timeout_sec: int) -> None:
        self.host = host
        self.port = port
        self.client_id = client_id
        self.connect_timeout_sec = connect_timeout_sec

    def scan(self, req: IbkrScannerRequest) -> list[str]:
        try:
            from ib_insync import IB, ScannerSubscription  # type: ignore[import-not-found]
        except Exception as e:
            raise RuntimeError(
                "IBKR scanner requires ib_insync. Install it with: `python -m pip install ib-insync`."
            ) from e

        ib = IB()
        try:
            ib.connect(self.host, self.port, clientId=self.client_id, timeout=self.connect_timeout_sec)

            sub = ScannerSubscription()
            sub.instrument = req.instrument
            sub.locationCode = req.location_code
            sub.scanCode = req.scan_code
            sub.numberOfRows = int(req.number_of_rows)

            scan_data = ib.reqScannerSubscription(sub)
            # ib_insync returns a live ScanDataList that updates asynchronously.
            # Give it a moment to populate, then cancel to avoid leaking subscriptions.
            ib.sleep(2.0)

            results = list(scan_data)
            with __import__("contextlib").suppress(Exception):
                ib.cancelScannerSubscription(scan_data)

            # results are list[ScannerData], each has contractDetails.contract.symbol
            symbols: list[str] = []
            for r in results:
                try:
                    sym = r.contractDetails.contract.symbol
                except Exception:
                    continue
                if sym:
                    symbols.append(str(sym).upper())
            return sorted(set(symbols))
        finally:
            try:
                ib.disconnect()
            except Exception:
                pass

