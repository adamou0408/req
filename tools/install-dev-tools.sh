#!/usr/bin/env bash
# Installs the lint and security-scan tools used by tools/check.sh on Debian/Ubuntu.
# Versions are pinned so local runs and CI give the same results.
set -euo pipefail

TRIVY_VERSION="0.76.2"
SQLFLUFF_VERSION="3.4.2"
ACTIONLINT_PY_VERSION="1.7.12.25"
HADOLINT_BIN_VERSION="2.15.1"

install_trivy() {
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://get.trivy.dev/deb/public.key | gpg --dearmor --yes -o /etc/apt/keyrings/trivy.gpg
    echo "deb [signed-by=/etc/apt/keyrings/trivy.gpg] https://get.trivy.dev/deb generic main" \
        > /etc/apt/sources.list.d/trivy.list
    apt-get update
    apt-get install -y "trivy=${TRIVY_VERSION}"
}

install_apt_tools() {
    # plpgsql_check is only needed in development and CI databases, never in production.
    apt-get install -y shellcheck postgresql-16-plpgsql-check
}

install_python_tools() {
    pip3 install \
        "sqlfluff==${SQLFLUFF_VERSION}" \
        "actionlint-py==${ACTIONLINT_PY_VERSION}" \
        "hadolint-bin==${HADOLINT_BIN_VERSION}"
}

install_trivy
install_apt_tools
install_python_tools

trivy --version | head -1
shellcheck --version | sed -n 2p
sqlfluff --version
actionlint --version | head -1
hadolint --version
