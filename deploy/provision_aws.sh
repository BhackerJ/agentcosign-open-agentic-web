#!/usr/bin/env bash
# Creates the host on AWS: a role that reads the settings, a security group open on 80 and
# 443, one small instance that runs setup_host.sh at first boot, and a fixed address.
# Usage: provision_aws.sh   (AWS CLI credentials in the environment)
# Set the store-host and buyer-host parameters first (see README.md).
set -euo pipefail
name="${NAME:-agentcosign-oaw}"
path="${PARAMETER_PATH:-/agentcosign-oaw}"
region="${AWS_REGION:-us-east-1}"
type="${INSTANCE_TYPE:-t4g.micro}"
export AWS_DEFAULT_REGION="$region"
account="$(aws sts get-caller-identity --query Account --output text)"

aws iam create-role --role-name "$name" --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
aws iam attach-role-policy --role-name "$name" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam put-role-policy --role-name "$name" --policy-name read-settings --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\",\"ssm:GetParametersByPath\"],\"Resource\":[\"arn:aws:ssm:${region}:${account}:parameter${path}\",\"arn:aws:ssm:${region}:${account}:parameter${path}/*\"]}]}"
aws iam create-instance-profile --instance-profile-name "$name" >/dev/null
aws iam add-role-to-instance-profile --instance-profile-name "$name" --role-name "$name"

vpc="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
group="$(aws ec2 create-security-group --group-name "$name" --description "Web ports for the AgentCosign demo sites" --vpc-id "$vpc" --query GroupId --output text)"
aws ec2 authorize-security-group-ingress --group-id "$group" --ip-permissions \
  'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
  'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null

image="$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)"
user_data="$(printf '#!/bin/bash\nexport PARAMETER_PATH=%s AWS_REGION=%s\ncurl -fsSL https://raw.githubusercontent.com/BhackerJ/agentcosign-open-agentic-web/main/deploy/setup_host.sh | bash > /var/log/oaw-setup.log 2>&1\n' "$path" "$region")"

# A new instance profile takes a few seconds to become usable.
sleep 12
instance="$(aws ec2 run-instances --image-id "$image" --instance-type "$type" --security-group-ids "$group" \
  --iam-instance-profile "Name=$name" --user-data "$user_data" \
  --metadata-options 'HttpTokens=required' \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=10,VolumeType=gp3}' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$name},{Key=project,Value=$name}]" \
  --query 'Instances[0].InstanceId' --output text)"
aws ec2 wait instance-running --instance-ids "$instance"
allocation="$(aws ec2 allocate-address --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$name},{Key=project,Value=$name}]" --query AllocationId --output text)"
aws ec2 associate-address --instance-id "$instance" --allocation-id "$allocation" >/dev/null
address="$(aws ec2 describe-addresses --allocation-ids "$allocation" --query 'Addresses[0].PublicIp' --output text)"
echo "Instance $instance at $address. Point both host names at that address."
