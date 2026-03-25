#!/usr/bin/env bash
set -euo pipefail

VM_IP="${1:?Usage: ./configure-vm.sh <VM_PUBLIC_IP> <FLOATING_IP>}"
FLOATING_IP="${2:?Usage: ./configure-vm.sh <VM_PUBLIC_IP> <FLOATING_IP>}"
SSH_KEY="$HOME/.ssh/hetzner_ed25519"

echo "==> Waiting for VM to be ready..."
until ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@"$VM_IP" "echo ready" 2>/dev/null; do
  echo "   Not ready yet, retrying in 5s..."
  sleep 5
done

echo "==> Configuring floating IP $FLOATING_IP on VM..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no root@"$VM_IP" bash <<EOF
cat > /etc/netplan/99-floating-ipv4.yaml << 'NETPLAN'
network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - ${FLOATING_IP}/32
NETPLAN
netplan apply
ip addr show eth0 | grep ${FLOATING_IP} && echo "Floating IP confirmed on eth0" || echo "WARNING: floating IP not found on eth0"
EOF

echo ""
echo "✅ Done. Floating IP $FLOATING_IP is now configured."
echo "   Point your DNS A record to: $FLOATING_IP"
echo "   Then run Script 3: ./install-coolify.sh $VM_IP"
