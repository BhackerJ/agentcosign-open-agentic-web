#!/usr/bin/env bash
# Watches both public sites from outside and mails an address when one stops answering.
#
#   ALERT_EMAIL=you@example.com deploy/monitor_aws.sh
#
# Two Route 53 health checks: the store's /products.json, which reads the catalog from Shopify,
# and the buyer site's /health, which is 200 only while the site-funded model answers. Each has
# a CloudWatch alarm that mails the SNS topic's subscribers on failure and on recovery. Safe to
# run again, for example after the host names change: it updates the checks in place. The
# first run subscribes ALERT_EMAIL, and the mail it gets asks for one click to confirm.
set -euo pipefail
path="${PARAMETER_PATH:-/agentcosign-oaw}"
region=us-east-1 # Route 53 health-check metrics exist in us-east-1 only.
topic_name=agentcosign-oaw-alerts

param() {
  aws ssm get-parameter --name "$path/$1" --region "$region" --query Parameter.Value --output text
}
store_host="$(param store-host)"
buyer_host="$(param buyer-host)"

topic="$(aws sns create-topic --region "$region" --name "$topic_name" --query TopicArn --output text)"
if [ -n "${ALERT_EMAIL:-}" ]; then
  subscribed="$(aws sns list-subscriptions-by-topic --region "$region" --topic-arn "$topic" \
    --query "Subscriptions[?Endpoint=='${ALERT_EMAIL}'] | length(@)" --output text)"
  [ "$subscribed" = 0 ] && aws sns subscribe --region "$region" --topic-arn "$topic" --protocol email \
    --notification-endpoint "$ALERT_EMAIL" >/dev/null
fi

# watch NAME HOST PATH TEXT: a health check that wants TEXT in the answer, and its alarm.
watch() {
  local name="$1" host="$2" resource="$3" text="$4" id
  id="$(aws route53 list-health-checks --query \
    "HealthChecks[?HealthCheckConfig.FullyQualifiedDomainName=='${host}' && HealthCheckConfig.ResourcePath=='${resource}'].Id | [0]" \
    --output text)"
  if [ "$id" = None ] || [ -z "$id" ]; then
    # Three regions, the fewest Route 53 allows, keep the polling of the sites light.
    id="$(aws route53 create-health-check --caller-reference "${name}-$(date +%s)" --health-check-config \
      "Type=HTTPS_STR_MATCH,FullyQualifiedDomainName=${host},Port=443,ResourcePath=${resource},SearchString=${text},RequestInterval=30,FailureThreshold=3,Regions=us-east-1,us-west-2,eu-west-1" \
      --query HealthCheck.Id --output text)"
  else
    aws route53 update-health-check --health-check-id "$id" --search-string "$text" >/dev/null
  fi
  aws route53 change-tags-for-resource --resource-type healthcheck --resource-id "$id" --add-tags "Key=Name,Value=${name}"
  aws cloudwatch put-metric-alarm --region "$region" --alarm-name "$name" \
    --alarm-description "https://${host}${resource} has not answered with ${text} for about three minutes." \
    --namespace AWS/Route53 --metric-name HealthCheckStatus --dimensions "Name=HealthCheckId,Value=${id}" \
    --statistic Minimum --period 60 --evaluation-periods 3 --threshold 1 --comparison-operator LessThanThreshold \
    --treat-missing-data breaching --alarm-actions "$topic" --ok-actions "$topic"
  echo "$name: health check $id on https://${host}${resource}"
}

# The old checks of a site whose host name changed keep polling the old name: delete them by hand.
watch oaw-store-catalog "$store_host" /products.json OAW-DOCK-01
watch oaw-buyer-model "$buyer_host" /health '"ok":true'
