#!/usr/bin/env bash
# Prepares a fresh Oracle Ubuntu VM: Docker, plus ports 80 and 443 in the VM's own firewall.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# Oracle's Ubuntu images reject everything but SSH in iptables, on top of the cloud firewall.
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  sudo netfilter-persistent save
fi

echo "VM ready. Log out and back in once so the docker group applies."
