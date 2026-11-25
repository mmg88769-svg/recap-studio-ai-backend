# Google Cloud setup and deployment

This backend is designed for the Google Cloud project used by Myanmar SRT. The API and worker use service-account authentication for Cloud Storage, Firestore, Speech-to-Text, and Cloud Run Jobs. Gemini translation is called through a Google Apps Script web-app proxy; the Gemini API key is kept in Apps Script Script Properties and is not placed in the Android app.

## Fixed v1 deployment choices

- Cloud Run API and Cloud Run Job region: us-central1
- Cloud Storage bucket location: US multi-region
- Speech-to-Text V2 endpoint: us multi-region
- Speech model: chirp_3, automatic source-language detection, word timestamps
- Gemini translation: Gemini Developer API through Apps Script proxy
- Gemini model: gemini-3.5-flash-lite by default
- Maximum upload: 2 GiB by default
- Maximum movie duration: 4 hours by default

Chirp 3 is selected because Burmese (my-MM) is listed for the US multi-region endpoint. Keep the Cloud Storage bucket in the US multi-region for the Speech-to-Text job. The model's real accuracy must still be tested against representative movie clips.

## 1. Prepare the project

Open Google Cloud Console, select the project, and make sure billing is enabled. Google Cloud services used here are pay-as-you-go. Set a budget alert before running movie jobs.

Enable APIs:

    gcloud services enable \
      run.googleapis.com \
      storage.googleapis.com \
      speech.googleapis.com \
      firestore.googleapis.com \
      iamcredentials.googleapis.com \
      artifactregistry.googleapis.com \
      cloudbuild.googleapis.com

Set shell variables:

    export PROJECT_ID="YOUR_GOOGLE_CLOUD_PROJECT_ID"
    export REGION="us-central1"
    export BUCKET="${PROJECT_ID}-myanmar-srt"
    export SERVICE_ACCOUNT="myanmar-srt-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
    export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/myanmar-srt/backend:1.0.0"

## 2. Create Firestore and Storage

Create the Firestore database once if the project does not already have a default database:

    gcloud firestore databases create \
      --database="(default)" \
      --location="${REGION}" \
      --type=firestore-native

Create a private US multi-region bucket:

    gcloud storage buckets create "gs://${BUCKET}" \
      --location=US \
      --uniform-bucket-level-access

The worker deletes source video and temporary audio chunks after successful processing. Keep a bucket lifecycle rule to delete old job objects after a suitable retention period (for example, 7 days).

## 3. Create the runtime service account

    gcloud iam service-accounts create myanmar-srt-runtime \
      --display-name="Myanmar SRT Runtime"

Grant the service account access required by the API and worker:

    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/storage.objectAdmin"

    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/datastore.user"

    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/speech.client"

    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/run.developer"

Allow the service account to sign its own short-lived upload URLs through IAM Credentials:

    gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT}" \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/iam.serviceAccountTokenCreator"

The project must have the Service Account Credentials API enabled. The service account also needs permission to execute the Cloud Run Job with overrides.

## 4. Create the application token secret

Generate a private app token locally:

    openssl rand -hex 32

Create a Secret Manager secret. Paste the generated value when prompted; do not commit it to GitHub:

    printf '%s' 'PASTE_YOUR_NEW_RANDOM_TOKEN_HERE' | \
      gcloud secrets create APP_TOKEN --data-file=-

Grant the runtime service account access to the secret:

    gcloud secrets add-iam-policy-binding APP_TOKEN \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/secretmanager.secretAccessor"

This APP_TOKEN is the Token entered in the Android app. It is not a Google Gemini API key.

## 5. Configure the Gemini Apps Script proxy

Follow [apps-script-proxy-setup.md](apps-script-proxy-setup.md) to deploy the Apps Script web app, store `GEMINI_API_KEY` and `GEMINI_PROXY_TOKEN` in Script Properties, and copy its `/exec` URL.

Create the Cloud Run shared-token secret:

    printf '%s' 'PASTE_THE_SAME_RANDOM_PROXY_TOKEN_HERE' | \
      gcloud secrets create GEMINI_PROXY_TOKEN --data-file=-

    gcloud secrets add-iam-policy-binding GEMINI_PROXY_TOKEN \
      --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role="roles/secretmanager.secretAccessor"

Set the Apps Script deployment URL in your shell (do not commit it):

    export GEMINI_PROXY_URL="https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"

The new proxy setup does not require a `GEMINI_API_KEY` secret in Cloud Run. The worker sends only `GEMINI_PROXY_TOKEN`; Apps Script reads the Gemini API key from its own Script Properties. Optional `GEMINI_API_KEY` support remains for compatibility with the previous proxy request format.


## 6. Build the container image

    gcloud artifacts repositories create myanmar-srt \
      --repository-format=docker \
      --location="${REGION}" \
      --description="Myanmar SRT backend images"

From the backend repository root:

    gcloud builds submit --tag "${IMAGE}"

## 7. Create the Cloud Run worker Job

Create the worker Job before deploying the API:

    gcloud run jobs create myanmar-srt-worker \
      --image="${IMAGE}" \
      --region="${REGION}" \
      --service-account="${SERVICE_ACCOUNT}" \
      --cpu=4 \
      --memory=8Gi \
      --task-timeout=4h \
      --max-retries=1 \
      --tasks=1 \
      --parallelism=1 \
      --set-env-vars="PROJECT_ID=${PROJECT_ID},GCS_BUCKET=${BUCKET},STT_LOCATION=us,STT_MODEL=chirp_3,GEMINI_PROXY_URL=${GEMINI_PROXY_URL},GEMINI_MODEL=gemini-3.5-flash-lite,GEMINI_TIMEOUT_SECONDS=120,GEMINI_MAX_RETRIES=3,MAX_VIDEO_BYTES=2147483648,MAX_VIDEO_DURATION_SECONDS=14400" \
      --set-secrets="GEMINI_PROXY_TOKEN=GEMINI_PROXY_TOKEN:latest"

The API starts this Job with a per-execution JOB_ID override. The container entrypoint detects JOB_ID and runs the worker instead of starting the HTTP server.

## 8. Deploy the public API

The API is public at the Cloud Run network layer so the Android app can reach it. All application routes except /health require the private APP_TOKEN.

    gcloud run deploy myanmar-srt-api \
      --image="${IMAGE}" \
      --region="${REGION}" \
      --service-account="${SERVICE_ACCOUNT}" \
      --allow-unauthenticated \
      --memory=1Gi \
      --cpu=1 \
      --timeout=60 \
      --set-env-vars="PROJECT_ID=${PROJECT_ID},GCS_BUCKET=${BUCKET},SIGNING_SERVICE_ACCOUNT_EMAIL=${SERVICE_ACCOUNT},RUN_REGION=${REGION},RUN_JOB_NAME=myanmar-srt-worker,STT_LOCATION=us,STT_MODEL=chirp_3,MAX_VIDEO_BYTES=2147483648,MAX_VIDEO_DURATION_SECONDS=14400" \
      --set-secrets="APP_TOKEN=APP_TOKEN:latest"

Get the Server URL:

    gcloud run services describe myanmar-srt-api \
      --region="${REGION}" \
      --format="value(status.url)"

Enter that URL in the Android Server URL field. Enter the secret value generated in step 4 in the Token field. Never send the token in chat or put it in source code.

## 9. Smoke test

Check the health endpoint:

    curl "$(gcloud run services describe myanmar-srt-api --region="${REGION}" --format='value(status.url)')/health"

Then test the app with a short, non-sensitive video clip first. Check upload, job status, SRT download, Burmese Unicode, timestamps, and subtitle timing before trying a full-length movie.

## Cost and safety

- Speech-to-Text and Gemini translation are billable services.
- Cloud Run, Cloud Run Jobs, Cloud Storage, Firestore, and Artifact Registry may also incur charges.
- Configure a Google Cloud budget alert and review usage after the first short test.
- Do not share service-account keys, APP_TOKEN, signed upload URLs, or movie files in public repositories.
- The API does not store provider API keys in the APK.


If the Cloud Run Job already exists, use `gcloud run jobs update myanmar-srt-worker` with the same image, environment variables, and `--set-secrets="GEMINI_PROXY_TOKEN=GEMINI_PROXY_TOKEN:latest"` settings instead of running the create command again.
