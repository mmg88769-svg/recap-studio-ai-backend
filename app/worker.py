import logging
import sys

from app.pipeline import process_job


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


def run(job_id: str) -> None:
    if not job_id or len(job_id) > 80:
        raise ValueError("A valid JOB_ID is required.")
    logging.info("Starting Myanmar SRT job %s", job_id)
    process_job(job_id)
    logging.info("Finished Myanmar SRT job %s", job_id)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m app.worker JOB_ID")
    run(sys.argv[1])
