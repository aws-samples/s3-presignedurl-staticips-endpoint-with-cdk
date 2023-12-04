import {Duration, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {
    InterfaceVpcEndpoint,
    InterfaceVpcEndpointService,
    IpAddresses,
    Peer,
    Port,
    SecurityGroup,
    SubnetType,
    Vpc,
    VpcEndpoint
} from 'aws-cdk-lib/aws-ec2';
import {
    ApplicationLoadBalancer,
    ApplicationProtocol,
    ApplicationTargetGroup,
    ListenerAction,
    ListenerCondition,
    Protocol,
    SslPolicy,
    TargetType
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {BasePathMapping, DomainName, EndpointType, LambdaRestApi, SecurityPolicy} from 'aws-cdk-lib/aws-apigateway';
import {AwsCustomResource, AwsCustomResourcePolicy} from 'aws-cdk-lib/custom-resources';
import {IpTarget} from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import {Certificate} from "aws-cdk-lib/aws-certificatemanager";
import {ARecord, HostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {GlobalAcceleratorTarget} from "aws-cdk-lib/aws-route53-targets";
import {Accelerator} from "aws-cdk-lib/aws-globalaccelerator";
import {ApplicationLoadBalancerEndpoint} from "aws-cdk-lib/aws-globalaccelerator-endpoints";
import {Runtime} from "aws-cdk-lib/aws-lambda";
import {NodejsFunction} from "aws-cdk-lib/aws-lambda-nodejs";
import {AnyPrincipal, Effect, PolicyDocument, PolicyStatement} from "aws-cdk-lib/aws-iam";
import {Bucket, BucketEncryption} from "aws-cdk-lib/aws-s3";
import {options} from '../config';
import path = require('path');

export class UnifiedS3EndpointVpcStack extends Stack {
    vpc: Vpc;

    apiVpcEndpoint: VpcEndpoint;

    s3VpcEndpoint: VpcEndpoint;

    apiVpcEndpointIpAddresses: string[];

    s3VpcEndpointIpAddresses: string[];

    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);
        const vpc = new Vpc(this, 'Vpc', {
            ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
            subnetConfiguration: [
                {
                    name: 'public-subnet',
                    subnetType: SubnetType.PUBLIC
                },
                {
                    name: 'private-isolated-subnet',
                    subnetType: SubnetType.PRIVATE_ISOLATED
                }
            ]
        });

        const apiVpcEndpoint = new InterfaceVpcEndpoint(this, 'Api VPC Endpoint', {
            vpc,
            service: new InterfaceVpcEndpointService(`com.amazonaws.${this.region}.execute-api`, 443),
            subnets: {
                subnets: vpc.isolatedSubnets,
            }
        });

        const s3VpcEndpoint = new InterfaceVpcEndpoint(this, 'S3 VPC Endpoint', {
            vpc,
            service: new InterfaceVpcEndpointService(`com.amazonaws.${this.region}.s3`, 443),
            subnets: {
                subnets: vpc.isolatedSubnets,
            }
        });


        this.vpc = vpc;
        this.apiVpcEndpoint = apiVpcEndpoint;
        this.s3VpcEndpoint = s3VpcEndpoint;

        function getNetworkInterfaceProps(scope: Construct, idSufix: string, vpcEndpointId: string): AwsCustomResource {
            // use CDK custom resources to get the Network Interfaces and IP addresses of the VPC Endpoint
            const vpcEndpointProps = new AwsCustomResource(scope, `vpcEndpointProps-${idSufix}`, {
                onUpdate: {
                    service: 'EC2',
                    action: 'describeVpcEndpoints',
                    parameters: {
                        VpcEndpointIds: [vpcEndpointId],
                    },
                    physicalResourceId: {},
                },
                policy: AwsCustomResourcePolicy.fromSdkCalls({resources: AwsCustomResourcePolicy.ANY_RESOURCE}),
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
    vpc: Vpc,
    apiVpcEndpoint: VpcEndpoint,
    apiVpcEndpointIpAddresses: string[],
    s3VpcEndpoint: VpcEndpoint,
    s3VpcEndpointIpAddresses: string[],
}


export class UnifiedS3EndpointApplicationStack extends Stack {
    /**
     * Deploys API with Lambda function and GET method for presigned url generation.
     *
     * The GA and ALB sits in front of the ALB and includes a custom hostname
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
            vpc, apiVpcEndpoint, apiVpcEndpointIpAddresses, s3VpcEndpoint, s3VpcEndpointIpAddresses
        } = props;

        const {
            certificateArn, dnsAttr, domainNamePrefix, presignPath, objectsPath,
        } = options;

        // VPC - from the VPC stack
        // const vpc = Vpc.fromLookup(this, 'vpc', { vpcId });

        // Create the load balancer in a VPC. 'internetFacing' is 'false'
        // by default, which creates an internal load balancer.


        const certificate = Certificate.fromCertificateArn(this, 'cert', certificateArn)


        // DNS Zone
        const zone = HostedZone.fromHostedZoneAttributes(this, 'zone', dnsAttr);
        const {zoneName} = zone;

        // host and domain for the API URL
        const unifiedS3EndpointDomainName = `${domainNamePrefix}.${zoneName}`;

        // security group
        const albSg = new SecurityGroup(this, 'albSg', {
            description: 'ALB Endpoint SG',
            vpc,
            allowAllOutbound: false,
            disableInlineRules: true
        });

        albSg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(443), 'allow internal ALB access');
        albSg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(80), 'allow internal ALB access');
        albSg.addEgressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(80), 'allow 80 egress')
        albSg.addEgressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(443), 'allow 443 egress')

        const sgImmutable = SecurityGroup.fromSecurityGroupId(
            this,
            "LoadBalancerSecurityGroupImmutable",
            albSg.securityGroupId,
            { mutable: false }
        );

        const alb = new ApplicationLoadBalancer(this, 'LB', {
            vpc,
            internetFacing: false,
            securityGroup: sgImmutable,
            dropInvalidHeaderFields: true
        });


        const logBucket = new Bucket(this, "logBucket",
            {bucketName: `${unifiedS3EndpointDomainName}-logs`,
                encryption: BucketEncryption.S3_MANAGED
                    }

        );
        alb.logAccessLogs(logBucket, "albAccessLogs")

        // Create an Accelerator
        const accelerator = new Accelerator(this, 'Accelerator');

        // DNS alias for ALB
        new ARecord(this, 'gaAlias', {
            recordName: unifiedS3EndpointDomainName,
            zone,
            comment: 'Alias for GlobalAccelerator',
            target: RecordTarget.fromAlias(new GlobalAcceleratorTarget(accelerator)),
        });

        // Create a Listener
        const listener = accelerator.addListener('Listener', {
            portRanges: [
                {fromPort: 80},
                {fromPort: 443},
            ],
        });

        // Add one EndpointGroup for each Region we are targeting
        listener.addEndpointGroup('Group', {
            endpoints: [
                new ApplicationLoadBalancerEndpoint(alb, {
                    weight: 128,
                    preserveClientIp: true,

                }),
            ],
        });


        const bucket = new Bucket(this, "united.s3.bucket",
            {bucketName: unifiedS3EndpointDomainName,
                encryption: BucketEncryption.S3_MANAGED
            }
        );



        const handler = new NodejsFunction(this, "PreSignedURLHandler", {
            runtime: Runtime.NODEJS_18_X,
            entry: path.join(__dirname, "/../resources/presign.ts"),
            handler: "handler",
            environment: {
                BUCKET: bucket.bucketName
            }
        });

        bucket.grantReadWrite(handler);

        bucket.addToResourcePolicy(
            new PolicyStatement(
                {
                    principals: [new AnyPrincipal() ],
                    resources: [
                        bucket.arnForObjects("*"),
                        bucket.bucketArn
                    ],
                    actions: ["s3:GetObject"],
                    effect: Effect.DENY,
                    conditions: {
                        StringNotEquals: {
                            "aws:SourceVpce": s3VpcEndpoint.vpcEndpointId
                        }
                    }


                }
            )
        );

        const api = new LambdaRestApi(this, 'PrivateLambdaRestApi', {
            endpointTypes: [EndpointType.PRIVATE],
            handler: handler,
            policy: new PolicyDocument({
                statements: [
                    new PolicyStatement({
                        principals: [new AnyPrincipal],
                        actions: ['execute-api:Invoke'],
                        resources: ['execute-api:/*'],
                        effect: Effect.DENY,
                        conditions: {
                            StringNotEquals: {
                                "aws:SourceVpce": apiVpcEndpoint.vpcEndpointId
                            }
                        }
                    }),
                    new PolicyStatement({
                        principals: [new AnyPrincipal],
                        actions: ['execute-api:Invoke'],
                        resources: ['execute-api:/*'],
                        effect: Effect.ALLOW
                    })
                ]
            })
        })

        // Create the API domain
        const apiDomain = new DomainName(this, 'unifiedS3EndpointDomain', {
            domainName: unifiedS3EndpointDomainName,
            certificate,
            endpointType: EndpointType.REGIONAL, // API domains can only be created for Regional endpoints, but it will work with the Private endpoint anyway
            securityPolicy: SecurityPolicy.TLS_1_2,
        });
        // map API domain name to API
        new BasePathMapping(this, 'pathMappingPresignAPI', {
            basePath: presignPath,
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
                protocol: Protocol.HTTP,
                path: '/',
                interval: Duration.minutes(5),
                healthyHttpCodes: '307,403,405',
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
            sslPolicy:SslPolicy.TLS12_EXT
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
                ListenerCondition.pathPatterns([`/${presignPath}/*`]),
            ],
            priority: 1,
        });
        https.addAction('s3', {
            action: ListenerAction.forward([s3EndpointTargetGroup]),
            conditions: [
                ListenerCondition.pathPatterns([`/${objectsPath}/*`]),
            ],
            priority: 2,
        });
    }
}