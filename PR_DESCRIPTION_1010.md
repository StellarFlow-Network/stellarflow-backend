## Description

Introduce an automated container vulnerability scanning pipeline using Trivy in GitHub Actions. This ensures that all backend Docker images are continuously scanned for known security vulnerabilities prior to deployment. The pipeline is configured to fail the build automatically if any CRITICAL or HIGH severity CVE vulnerabilities are identified, maintaining a strong security posture.

## Type of Change

- [ ] Bug fix
- [x] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing

- [x] Tested locally
- [ ] Added unit tests
- [x] Verified GitHub Actions workflow configuration

## Related Issues

Closes #1010

### Implementation completed

- Created `.github/workflows/deploy.yml` deployment workflow for pushes and pull requests to the `main` branch.
- Added steps to build the `stellarflow-backend` Docker image from the provided `Dockerfile`.
- Integrated `aquasecurity/trivy-action` to run vulnerability scans directly against the built image.
- Configured Trivy to fail the pipeline (exit-code 1) if vulnerabilities matching `CRITICAL` or `HIGH` severities are detected.
- Configured SARIF report generation and added the `github/codeql-action/upload-sarif` step to upload vulnerability results to the GitHub Security tab for centralized visibility.
