#!/bin/bash
# Routes all outgoing traffic from Docker containers through 51.79.44.198
# Run once after reboot or add to /etc/rc.local

BOT_IP="51.79.44.198"
DOCKER_SUBNET=$(docker network inspect byob-docker_botnet --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null)

if [ -z "$DOCKER_SUBNET" ]; then
  echo "Start docker-compose first: docker compose up -d"
  exit 1
fi

echo "Setting SNAT for $DOCKER_SUBNET -> $BOT_IP"
iptables -t nat -A POSTROUTING -s "$DOCKER_SUBNET" ! -o docker0 -j SNAT --to-source "$BOT_IP"
echo "Done."
