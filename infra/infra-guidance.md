# Azure details

Subscription=34a90797-7603-486a-bc81-222e06b01861
resource_group=rg-specmate-prod
Use infra folder and create required infra components

- create containers apps environment
- create containers apps - frontend and backend
- create postgres sql ( make it public and I will add firewall rules to restrict later)
- configure all the required secrets and envs in Keyvault (create new KV in the same rg)

# CICD

Use github actions to deploy to Azure Container Apps
Package the apps separately into web and api
write pipelines for both

tell me any manual steps I need to do.
