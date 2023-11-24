#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {ApplicationStack, UnifiedS3EndpointStack} from '../lib/unified-s3-endpoint-stack';
import { options } from '../config';
const app = new cdk.App();


// use account details from default AWS CLI credentials:
// const account = process.env.CDK_DEFAULT_ACCOUNT;
// const region = process.env.CDK_DEFAULT_REGION;

const account = '026543866495';
const region = 'ap-northeast-2';

if (!options.albHostname || !options.apiPath1 || !options.apiPath2 || options.apiPath1 === options.apiPath2) { throw new Error('We need the ALB hostname and the api paths. API paths must be unique'); }


const vpcStack = new UnifiedS3EndpointStack(app, 'UnifiedS3EndpointStack', {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  env: { account, region },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});


const {
  vpc, apiVpcEndpoint, endpointIpAddresses,
} = vpcStack;

// Create API and ALB resource stack
new ApplicationStack(app, 'AlbApiDemoStack', {
  description: 'ALB API Demo Stack',
  env: { account, region },
  vpc,
  apiVpcEndpoint,
  endpointIpAddresses,
});