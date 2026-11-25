# Gemini Apps Script proxy setup

This project calls Gemini from the Cloud Run worker through a Google Apps Script web app. The Android app never receives the Gemini API key and does not call Gemini directly.

## 1. Create the Apps Script project

1. Open https://script.google.com/ and create a new standalone project.
2. Replace the editor contents with the code in [../apps_script/Code.gs](../apps_script/Code.gs).
3. Open **Project Settings** and find **Script Properties**.
4. Add these two properties:

| Property | Value |
|---|---|
| `GEMINI_API_KEY` | Your Google AI Studio API key |
| `GEMINI_PROXY_TOKEN` | A new random secret generated locally, for example with `openssl rand -hex 32` |

Do not put either value in Code.gs, GitHub, the Android app, or this chat.

## 2. Deploy as a web app

1. Select **Deploy → New deployment**.
2. Choose **Web app**.
3. Set **Execute as** to **Me**.
4. Set **Who has access** to **Anyone** so Cloud Run can call it without a Google login. The shared proxy token protects the endpoint.
5. Deploy and copy the URL ending in `/exec`.

After changing Code.gs, create a new deployment version or edit the existing deployment to use the new version.

## 3. Configure Cloud Run Job

Store the same random token in Google Secret Manager:

```bash
printf '%s' 'PASTE_THE_SAME_RANDOM_TOKEN_HERE' | \
  gcloud secrets create GEMINI_PROXY_TOKEN --data-file=-

gcloud secrets add-iam-policy-binding GEMINI_PROXY_TOKEN \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/secretmanager.secretAccessor"
```

Set the Apps Script URL as a Cloud Run Job environment variable and the token as a secret environment variable. See the deployment commands in [google-cloud-setup.md](google-cloud-setup.md).

For this new proxy implementation, the Gemini API key stays in Apps Script Script Properties. Do not create a Cloud Run `GEMINI_API_KEY` secret. The backend retains optional `GEMINI_API_KEY` support only for compatibility with the previous proxy contract.

## 4. Verify the proxy

Open the deployed `/exec` URL in a browser. The GET response should look like:

```json
{"status":"online","service":"gemini-apps-script-proxy","version":"1.0.0"}
```

A successful GET checks that the web app is deployed. The authenticated POST test is performed by the Cloud Run worker when a subtitle job is processed.

## Security notes

- Use a long random proxy token and keep it private.
- The Apps Script web app must be accessible to Cloud Run; the shared token is the application-level protection.
- The API key is sent to Google from Apps Script in the `x-goog-api-key` header.
- Never log request bodies, API keys, proxy tokens, or movie content.
- Apps Script and Gemini quotas still apply. A proxy does not bypass API quotas, billing rules, or account restrictions.
