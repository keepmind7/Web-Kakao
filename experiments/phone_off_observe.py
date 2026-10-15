"""휴대폰 OFF 확인 뒤 기존 로컬 연결·읽기 요청을 관찰한다. 인증·발송은 하지 않는다."""
import argparse
import json
import sys
import time
from pathlib import Path
from urllib import request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from tools.local_web import connect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm-phone-off", action="store_true")
    parser.add_argument("--seconds", type=int, default=120)
    args = parser.parse_args()
    if not args.confirm_phone_off or not 30 <= args.seconds <= 600:
        parser.error("휴대폰 OFF를 사용자가 확인해야 하며 관찰 범위는30~600초입니다.")
    started = time.monotonic()
    start_wall = int(time.time() * 1000)
    result = {"user_confirmed_phone_off": True, "requested_seconds": args.seconds,
              "start_wall_ms": start_wall, "samples": [], "queries": [],
              "auth_requests_started": False, "messages_sent": False,
              "raw_values_recorded": False, "passed": False}
    folder = ROOT / "evidence/phase2"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "phone-off-observation.json"

    def elapsed():
        return round(time.monotonic() - started, 3)

    def save():
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    try:
        url, client, initial = connect()
        auth_counts = initial.get("requests", {})
        connected_at = initial.get("reader", {}).get("connectedAt")

        def get(route):
            with client.open(url + route, timeout=4) as response:
                return json.load(response)

        def sample():
            state = get("/api/status")
            reader = state.get("reader", {})
            entry = {"elapsed_seconds": elapsed(), "auth_phase": state.get("phase"),
                     "credential_in_memory": state.get("credentialInMemory"),
                     "reader_phase": reader.get("phase"), "status": reader.get("status"),
                     "same_connection": reader.get("connectedAt") == connected_at,
                     "auth_request_counts_unchanged": state.get("requests") == auth_counts,
                     "history_busy": reader.get("historyBusy")}
            result["samples"].append(entry)
            save()
            if not (entry["auth_phase"] == "authenticated" and entry["credential_in_memory"]
                    and entry["reader_phase"] == "connected" and entry["same_connection"]
                    and entry["auth_request_counts_unchanged"]):
                raise RuntimeError("connection_changed")
            return state

        sample()
        rooms = get("/api/reader/rooms").get("rooms", [])
        selected = None
        for room in rooms:
            if room.get("historyAvailable") is not True:
                continue
            cached = get("/api/reader/messages?room=" + room["key"])
            if cached.get("history", {}).get("phase") == "idle":
                selected = room["key"]
                break
        if selected is None:
            selected = next((r["key"] for r in rooms if r.get("historyAvailable") is True), None)
        if selected is None:
            raise RuntimeError("no_queryable_room")

        def query():
            state = sample()
            if state.get("reader", {}).get("historyBusy"):
                raise RuntimeError("another_query_active")
            req = request.Request(url + "/api/reader/history",
                data=json.dumps({"room": selected}).encode(), method="POST",
                headers={"Origin": url, "Content-Type": "application/json",
                         "X-CSRF-Token": state["csrf"]})
            with client.open(req, timeout=4) as response:
                if response.status != 202:
                    raise RuntimeError("query_not_accepted")
                response.read(65536)
            deadline = time.monotonic() + 24
            while True:
                page = get("/api/reader/messages?room=" + selected)
                history = page.get("history", {})
                if history.get("phase") != "loading":
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("query_deadline")
                time.sleep(.2)
            result["queries"].append({"elapsed_seconds": elapsed(),
                "phase": history.get("phase"), "received_count": history.get("receivedCount"),
                "accepted_count": history.get("acceptedCount"),
                "display_count": len(page.get("messages", [])), "gap": history.get("gap")})
            save()
            if history.get("phase") != "loaded":
                raise RuntimeError("query_failed")
            print(json.dumps({"event": "query_completed", **result["queries"][-1]}), flush=True)

        query()
        second_query = False
        while elapsed() < args.seconds:
            time.sleep(min(10, max(.01, args.seconds - elapsed())))
            sample()
            if not second_query and elapsed() >= args.seconds - 15:
                query()
                second_query = True
        sample()
        result["observed_seconds"] = elapsed()
        result["passed"] = second_query and len(result["queries"]) == 2
        print(json.dumps({"passed": result["passed"], "observed_seconds": result["observed_seconds"],
                          "queries": len(result["queries"]), "samples": len(result["samples"])}))
    except Exception:
        result["failure"] = "observation_or_read_request_failed"
        result["observed_seconds"] = elapsed()
        print(json.dumps({"passed": False, "reason": result["failure"]}))
    finally:
        save()
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
