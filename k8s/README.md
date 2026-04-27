# Kubernetes Deployment for StellarFlow Backend

This directory contains the Kubernetes configuration files to deploy StellarFlow Backend to a Kubernetes cluster.

## Prerequisites

- A running Kubernetes cluster
- `kubectl` configured to access your cluster
- Docker image built and pushed to a registry (e.g., `stellarflow/stellarflow-backend:latest`)
- PostgreSQL and Redis services available in the cluster (or external)

## Files

- `deployment.yaml`: Deployment configuration with 3 replicas, health checks, and resource limits
- `service.yaml`: LoadBalancer service to expose the application on port 80
- `hpa.yaml`: Horizontal Pod Autoscaler for automatic scaling based on CPU (70%) and memory (80%) utilization
- `configmap.yaml`: Configuration values that can be changed without rebuilding the image
- `secret.yaml`: Sensitive configuration values stored as Kubernetes secrets

## Deployment Steps

1. **Update Configuration**:
   - Edit `configmap.yaml` and `secret.yaml` with your actual values
   - Update the Docker image in `deployment.yaml` to point to your registry
   - Ensure database and Redis services are available (you may need to deploy them separately)

2. **Create Secrets**:

   ```bash
   # Create the secret with actual values
   kubectl apply -f secret.yaml
   # Or create interactively:
   kubectl create secret generic stellarflow-secrets \
     --from-literal=database-url='postgresql://...' \
     --from-literal=redis-url='redis://...' \
     --from-literal=stellar-secret='your-secret' \
     # ... add other secrets
   ```

3. **Create ConfigMap**:

   ```bash
   kubectl apply -f configmap.yaml
   ```

4. **Deploy the Application**:

   ```bash
   kubectl apply -f deployment.yaml
   kubectl apply -f service.yaml
   kubectl apply -f hpa.yaml
   ```

5. **Verify Deployment**:

   ```bash
   kubectl get pods
   kubectl get services
   kubectl get hpa
   ```

6. **Check Logs**:
   ```bash
   kubectl logs -l app=stellarflow-backend
   ```

## Scaling

The HPA is configured to:

- Maintain minimum 3 replicas
- Scale up to maximum 10 replicas
- Scale based on CPU utilization (target 70%) and memory utilization (target 80%)

You can adjust these values in `hpa.yaml` as needed.

## Health Checks

The deployment includes:

- Liveness probe: Checks `/health` endpoint every 10 seconds after 30 seconds initial delay
- Readiness probe: Checks `/health` endpoint every 5 seconds after 5 seconds initial delay

## Environment Variables

All required environment variables are configured in the deployment. Make sure to update the ConfigMap and Secret with appropriate values for your environment.

## Database and Redis

The deployment expects PostgreSQL and Redis to be available. You can deploy them using:

- Bitnami PostgreSQL Helm chart
- Bitnami Redis Helm chart
- Or deploy custom manifests

Update the connection strings in the secret accordingly.
