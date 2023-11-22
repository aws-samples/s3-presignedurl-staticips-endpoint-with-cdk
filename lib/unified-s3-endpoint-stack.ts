import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as globalaccelerator from 'aws-cdk-lib/aws-globalaccelerator';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ga_endpoints from 'aws-cdk-lib/aws-globalaccelerator-endpoints';

export class UnifiedS3EndpointStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create an Accelerator
    const accelerator = new globalaccelerator.Accelerator(this, 'Accelerator');

    // Create a Listener
    const listener = accelerator.addListener('Listener', {
      portRanges: [
        { fromPort: 80 },
        { fromPort: 443 },
      ],
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16')
    });

    // Create the load balancer in a VPC. 'internetFacing' is 'false'
    // by default, which creates an internal load balancer.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'LB', {
      vpc
    });

    // Add one EndpointGroup for each Region we are targeting
    listener.addEndpointGroup('Group', {
      endpoints: [
        new ga_endpoints.ApplicationLoadBalancerEndpoint(alb, {
          weight: 128,
          preserveClientIp: true,
        }),
      ],
    });


  }
}
