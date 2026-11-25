import os


def main() -> None:
    job_id = os.getenv("JOB_ID", "").strip()
    if job_id:
        from app.worker import run

        run(job_id)
        return

    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8080")))


if __name__ == "__main__":
    main()
