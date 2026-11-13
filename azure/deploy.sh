#!/usr/bin/env bash
# Aprovisiona la infraestructura de ProShop en Azure (ejecutar una sola vez).
# Requisitos: Azure CLI (az login hecho) y la imagen ya publicada en ghcr.io (pública).
# Uso:  MONGO_URI='mongodb+srv://...' JWT_SECRET='...' PAYPAL_CLIENT_ID='...' \
#       PAYPAL_APP_SECRET='...' GHCR_IMAGE='ghcr.io/<usuario>/proshop:latest' ./azure/deploy.sh
set -euo pipefail

LOCATION="${LOCATION:-eastus}"
RG="rg-proshop"
SUFFIX="${SUFFIX:-$RANDOM}"
LOG="log-proshop-${SUFFIX}"
ENV_NAME="cae-proshop"
APP="proshop-app"
STORAGE="stproshop${SUFFIX}"     # solo minúsculas y números, único global
CONTAINER="product-images"
KV="kv-proshop-${SUFFIX}"        # único global

az extension add --name containerapp --upgrade -y
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait

echo "== 1. Grupo de recursos"
az group create -n "$RG" -l "$LOCATION" -o none

echo "== 2. Log Analytics (monitoreo centralizado)"
az monitor log-analytics workspace create -g "$RG" -n "$LOG" -l "$LOCATION" -o none
sleep 20
sleep 20
LOG_ID=$(az monitor log-analytics workspace show -g "$RG" -n "$LOG" --query customerId -o tsv)
LOG_KEY=$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LOG" --query primarySharedKey -o tsv)

echo "== 3. Entorno de Container Apps"
az containerapp env create -g "$RG" -n "$ENV_NAME" -l "$LOCATION" \
  --logs-workspace-id "$LOG_ID" --logs-workspace-key "$LOG_KEY" -o none

echo "== 4. Storage para imágenes (lectura pública solo a nivel de blob, TLS 1.2)"
az storage account create -g "$RG" -n "$STORAGE" -l "$LOCATION" \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
  --allow-blob-public-access true --https-only true -o none
az storage container create --account-name "$STORAGE" -n "$CONTAINER" \
  --public-access blob --auth-mode login -o none

echo "== 5. Key Vault con modelo RBAC"
az keyvault create -g "$RG" -n "$KV" -l "$LOCATION" --enable-rbac-authorization true -o none
ME=$(az ad signed-in-user show --query id -o tsv)
KV_ID=$(az keyvault show -n "$KV" --query id -o tsv)
az role assignment create --assignee "$ME" --role "Key Vault Secrets Officer" --scope "$KV_ID" -o none
sleep 30   # propagación de permisos
az keyvault secret set --vault-name "$KV" -n mongo-uri        --value "$MONGO_URI" -o none
az keyvault secret set --vault-name "$KV" -n jwt-secret       --value "$JWT_SECRET" -o none
az keyvault secret set --vault-name "$KV" -n paypal-client-id --value "$PAYPAL_CLIENT_ID" -o none
az keyvault secret set --vault-name "$KV" -n paypal-secret    --value "$PAYPAL_APP_SECRET" -o none

echo "== 6. Container App con identidad administrada"
az containerapp create -g "$RG" -n "$APP" --environment "$ENV_NAME" \
  --image "$GHCR_IMAGE" --target-port 5000 --ingress external \
  --cpu 0.5 --memory 1.0Gi --min-replicas 0 --max-replicas 5 \
  --system-assigned -o none

PRINCIPAL=$(az containerapp show -g "$RG" -n "$APP" --query identity.principalId -o tsv)
ST_ID=$(az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv)

echo "== 7. Permisos mínimos para la identidad de la app"
az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$KV_ID" -o none
az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" --scope "$ST_ID" -o none
sleep 30

echo "== 8. Secretos referenciados desde Key Vault"
KV_URI="https://${KV}.vault.azure.net/secrets"
az containerapp secret set -g "$RG" -n "$APP" --secrets \
  "mongo-uri=keyvaultref:${KV_URI}/mongo-uri,identityref:system" \
  "jwt-secret=keyvaultref:${KV_URI}/jwt-secret,identityref:system" \
  "paypal-client-id=keyvaultref:${KV_URI}/paypal-client-id,identityref:system" \
  "paypal-secret=keyvaultref:${KV_URI}/paypal-secret,identityref:system" -o none

echo "== 9. Variables de entorno y regla de escalado HTTP"
az containerapp update -g "$RG" -n "$APP" \
  --set-env-vars NODE_ENV=production PORT=5000 \
    MONGO_URI=secretref:mongo-uri JWT_SECRET=secretref:jwt-secret \
    PAYPAL_CLIENT_ID=secretref:paypal-client-id PAYPAL_APP_SECRET=secretref:paypal-secret \
    PAYPAL_API_URL=https://api-m.sandbox.paypal.com \
    AZURE_STORAGE_ACCOUNT="$STORAGE" AZURE_STORAGE_CONTAINER="$CONTAINER" \
  --scale-rule-name http-concurrencia --scale-rule-type http \
  --scale-rule-http-concurrency 20 \
  --min-replicas 0 --max-replicas 5 -o none

FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo ""
echo "Listo. URL de la aplicación: https://${FQDN}"
echo "Salud:                       https://${FQDN}/api/health"
