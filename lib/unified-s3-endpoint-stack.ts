import * as cdk from 'aws-cdk-lib';
import {Duration, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as globalaccelerator from 'aws-cdk-lib/aws-globalaccelerator';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  TargetType
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {Peer, Port, SecurityGroup} from 'aws-cdk-lib/aws-ec2';
import * as ga_endpoints from 'aws-cdk-lib/aws-globalaccelerator-endpoints';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import {BasePathMapping, DomainName, EndpointType, SecurityPolicy} from 'aws-cdk-lib/aws-apigateway';
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import {AwsCustomResource, AwsCustomResourcePolicy} from 'aws-cdk-lib/custom-resources';
import * as iam from "aws-cdk-lib/aws-iam";
import {IpTarget} from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import {options} from '../config';
import {Certificate} from "aws-cdk-lib/aws-certificatemanager";
import {ARecord, HostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {GlobalAcceleratorTarget} from "aws-cdk-lib/aws-route53-targets";
import {NodejsFunction} from "aws-cdk-lib/aws-lambda-nodejs";
import path = require('path');

export class UnifiedS3EndpointStack extends cdk.Stack {
  vpc: ec2.Vpc;

  apiVpcEndpoint: ec2.VpcEndpoint;

  apiVpcEndpointIpAddresses: string[];

  s3VpcEndpointIpAddresses: string[];
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      subnetConfiguration: [
          {
            name: 'public-subnet',
            subnetType: ec2.SubnetType.PUBLIC
          },
        {
          name: 'private-isolated-subnet',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED
        }
      ]
    });

    const apiVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'Api VPC Endpoint', {
      vpc,
      service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${this.region}.execute-api`, 443),
      // Choose which availability zones to place the VPC endpoint in, based on
      // available AZs
      subnets: {
        subnets: vpc.isolatedSubnets,
        // availabilityZones: ['ap-northeast-2a', 'ap-northeast-2c']
      }
    });

    const s3VpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'S3 VPC Endpoint', {
      vpc,
      service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${this.region}.s3`, 443),
      // Choose which availability zones to place the VPC endpoint in, based on
      // available AZs
      subnets: {
        subnets: vpc.isolatedSubnets,
        // availabilityZones: ['ap-northeast-2a', 'ap-northeast-2c']
      }
    });


    this.vpc = vpc;
    this.apiVpcEndpoint = apiVpcEndpoint;

    function getNetworkInterfaceProps(scope:Construct, idSufix:string, vpcEndpointId:string): AwsCustomResource{
      // use CDK custom resources to get the Network Interfaces and IP addresses of the API Endpoint
      const vpcEndpointProps = new AwsCustomResource(scope, `vpcEndpointProps-${idSufix}`, {
        onUpdate: {
          service: 'EC2',
          action: 'describeVpcEndpoints',
          parameters: {
            VpcEndpointIds: [vpcEndpointId],
          },
          physicalResourceId: {},
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
        logRetention: 7,
      });
      return new AwsCustomResource(scope, `networkInterfaceProps-${idSufix}`, {
        onUpdate: {
          service: 'EC2',
          action: 'describeNetworkInterfaces',
          parameters: {
            NetworkInterfaceIds: [
              vpcEndpointProps.getResponseField('VpcEndpoints.0.NetworkInterfaceIds.0'),
              vpcEndpointProps.getResponseField('VpcEndpoints.0.NetworkInterfaceIds.1'),
            ],
          },
          physicalResourceId: {},
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({resources: AwsCustomResourcePolicy.ANY_RESOURCE}),
        logRetention: 7,
      })

    }

    const networkInterfaceProps = getNetworkInterfaceProps(this, 'api', apiVpcEndpoint.vpcEndpointId);

    this.apiVpcEndpointIpAddresses = [
      networkInterfaceProps.getResponseField('NetworkInterfaces.0.PrivateIpAddress'),
      networkInterfaceProps.getResponseField('NetworkInterfaces.1.PrivateIpAddress'),
    ];

    const networkInterfaceProps2 = getNetworkInterfaceProps(this, 's3', s3VpcEndpoint.vpcEndpointId);

    this.s3VpcEndpointIpAddresses = [
      networkInterfaceProps2.getResponseField('NetworkInterfaces.0.PrivateIpAddress'),
      networkInterfaceProps2.getResponseField('NetworkInterfaces.1.PrivateIpAddress'),
    ];

  }
}
interface ApplicationStackProps extends StackProps {
  vpc: ec2.Vpc,
  apiVpcEndpoint: ec2.VpcEndpoint,
  apiVpcEndpointIpAddresses: string[],
  s3VpcEndpointIpAddresses: string[],
}


export class ApplicationStack extends Stack {
  /**
   * Deploys two simple API's with Lambda function and GET method.
   * API Url is output for use in testing.
   *
   * The ALB sits in front of the API's and includes a custom hostname
   * configured in Route53.
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   *
   */
  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    const {
      vpc, apiVpcEndpoint, apiVpcEndpointIpAddresses, s3VpcEndpointIpAddresses
    } = props;

    const {
      certificateArn, dnsAttr, apiPrefix, apiPath1, apiPath2,
    } = options;

    // // VPC - from the VPC stack
    // const vpc = Vpc.fromLookup(this, 'vpc', { vpcId });

    // Create the load balancer in a VPC. 'internetFacing' is 'false'
    // by default, which creates an internal load balancer.


    const certificate = Certificate.fromCertificateArn(this, 'cert', certificateArn)


    // DNS Zone
    const zone = HostedZone.fromHostedZoneAttributes(this, 'zone', dnsAttr);
    const { zoneName } = zone;

    // host and domain for the API URL
    const apiDomainName = `${apiPrefix}.${zoneName}`;

    // security group
    const albSg = new SecurityGroup(this, 'albSg', {
      description: 'ALB Endpoint SG',
      vpc,
      allowAllOutbound: true,
    });

    albSg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(443), 'allow internal ALB access');
    albSg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(80), 'allow internal ALB access');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'LB', {
      vpc,
      internetFacing: false,
      securityGroup: albSg,
    });




    // Create an Accelerator
    const accelerator = new globalaccelerator.Accelerator(this, 'Accelerator');


    // DNS alias for ALB
    new ARecord(this, 'gaAlias', {
      recordName: apiDomainName,
      zone,
      comment: 'Alias for GlobalAccelerator',
      target: RecordTarget.fromAlias(new GlobalAcceleratorTarget(accelerator)),
    });

    // Create a Listener
    const listener = accelerator.addListener('Listener', {
      portRanges: [
        { fromPort: 80 },
        { fromPort: 443 },
      ],
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



    const bucket = new s3.Bucket(this, "united.s3.bucket",
        {bucketName: apiDomainName}
        );

    const handler = new NodejsFunction(this, "PreSignedURLHandler", {
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: path.join(__dirname, "/../resources/presign.ts"),
      handler: "handler",
      environment: {
        BUCKET: bucket.bucketName
      }
    });

    bucket.grantReadWrite(handler);


    const api = new apigateway.LambdaRestApi(this, 'PrivateLambdaRestApi', {
      endpointTypes: [apigateway.EndpointType.PRIVATE],
      handler: handler,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            principals: [new iam.AnyPrincipal],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            effect: iam.Effect.DENY,
            conditions: {
              StringNotEquals: {
                "aws:SourceVpce": apiVpcEndpoint.vpcEndpointId
              }
            }
          }),
          new iam.PolicyStatement({
            principals: [new iam.AnyPrincipal],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            effect: iam.Effect.ALLOW
          })
        ]
      })
    })

    // Create the API domain
    const apiDomain = new DomainName(this, 'apiDomain', {
      domainName: apiDomainName,
      certificate,
      endpointType: EndpointType.REGIONAL, // API domains can only be created for Regional endpoints, but it will work with the Private endpoint anyway
      securityPolicy: SecurityPolicy.TLS_1_2,
    });
    // map API domain name to API
    new BasePathMapping(this, 'pathMapping1', {
      basePath: apiPath1,
      domainName: apiDomain,
      restApi: api,
    });

    // add targets
    const ipTargets = apiVpcEndpointIpAddresses.map((ip) => new IpTarget(ip));
    const apiTargetGroup = new ApplicationTargetGroup(this, 'apiEndpointGroup', {
      targetGroupName: 'ApiEndpoints',
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      healthCheck: {
        path: '/',
        interval: Duration.minutes(5),
        healthyHttpCodes: '403',
      },
      targetType: TargetType.IP,
      targets: ipTargets,
      vpc,
    });


    // add targets
    const s3EndpointIpTargets = s3VpcEndpointIpAddresses.map((ip) => new IpTarget(ip));
    const s3EndpointTargetGroup = new ApplicationTargetGroup(this, 's3EndpointGroup', {
      targetGroupName: 'S3Endpoints',
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      healthCheck: {
        path: '/',
        interval: Duration.minutes(5),
        healthyHttpCodes: '403',
      },
      targetType: TargetType.IP,
      targets: s3EndpointIpTargets,
      vpc,
    });

    // listeners
    const https = alb.addListener('https', {
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [certificate],
    });

    // addRedirect will create a HTTP listener and redirect to HTTPS
    alb.addRedirect({
      sourceProtocol: ApplicationProtocol.HTTP,
      sourcePort: 80,
      targetProtocol: ApplicationProtocol.HTTPS,
      targetPort: 443,
    });

    // add routing actions. Send a 404 response if the request does not match one of our API paths
    https.addAction('default', {
      action: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Nothing to see here',
      }),
    });
    https.addAction('apis', {
      action: ListenerAction.forward([apiTargetGroup]),
      conditions: [
        ListenerCondition.pathPatterns([`/${apiPath1}`]),
      ],
      priority: 1,
    });
    https.addAction('s3', {
      action: ListenerAction.forward([s3EndpointTargetGroup]),
      conditions: [
        ListenerCondition.pathPatterns([`/${apiPath2}`]),
      ],
      priority: 2,
    });
  }
}