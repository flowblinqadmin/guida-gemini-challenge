#!/bin/bash
# Deploy Guida to Google Cloud Run
# Usage: ./deploy.sh
# Requires: gcloud CLI authenticated, project set
# Bonus: This script serves as infrastructure-as-code for automated deployment

set -euo pipefail

# ── Config ──────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:-guida-hackathon}"
REGION="us-central1"
SERVICE_NAME="guida"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# ── Preflight checks ───────────────────────────────────
echo "=== Guida — Cloud Run Deployment ==="
echo "Project:  ${PROJECT_ID}"
echo "Region:   ${REGION}"
echo "Service:  ${SERVICE_NAME}"
echo ""

if ! command -v gcloud &> /dev/null; then
    echo "ERROR: gcloud CLI not found. Install: brew install google-cloud-sdk"
    exit 1
fi

if [ -z "${GOOGLE_API_KEY:-}" ]; then
    echo "ERROR: GOOGLE_API_KEY not set. Export it before running."
    exit 1
fi

# Verify auth
ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null || true)
if [ -z "$ACCOUNT" ]; then
    echo "ERROR: Not authenticated. Run: gcloud auth login"
    exit 1
fi
echo "Authenticated as: ${ACCOUNT}"

# Set project
gcloud config set project "${PROJECT_ID}" --quiet

# ── Enable required APIs ────────────────────────────────
echo ""
echo "Enabling required APIs..."
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    containerregistry.googleapis.com \
    --quiet

# ── Build container ─────────────────────────────────────
echo ""
echo "Building container image..."
gcloud builds submit --tag "${IMAGE}" .

# ── Deploy to Cloud Run ─────────────────────────────────
echo ""
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
    --set-env-vars "GOOGLE_API_KEY=${GOOGLE_API_KEY},FLOWBLINQ_API_URL=${FLOWBLINQ_API_URL:-https://dev-brands-api.flowblinq.com},FLOWBLINQ_BRAND_ID=${FLOWBLINQ_BRAND_ID:-}"

# ── Verify ──────────────────────────────────────────────
echo ""
echo "=== Deployment Complete ==="
URL=$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --format 'value(status.url)')
echo "Live URL: ${URL}"
echo ""
echo "Verify:"
echo "  curl -s ${URL} | head -20"
echo "  gcloud run services describe ${SERVICE_NAME} --region ${REGION}"
echo "  gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE_NAME}' --limit 10"
