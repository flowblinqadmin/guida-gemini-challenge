#!/bin/bash
# Deploy Guida to Google Cloud Run
# Requires: gcloud CLI authenticated, project set

set -e

PROJECT_ID="${GCP_PROJECT_ID:-guida-gemini-challenge}"
REGION="us-central1"
SERVICE_NAME="guida"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "Building container..."
gcloud builds submit --tag "${IMAGE}" .

echo "Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --port 8000 \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 3 \
  --set-env-vars "GOOGLE_API_KEY=${GOOGLE_API_KEY},FLOWBLINQ_API_URL=${FLOWBLINQ_API_URL},FLOWBLINQ_BRAND_ID=${FLOWBLINQ_BRAND_ID}"

echo "Deployed! URL:"
gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --format 'value(status.url)'
