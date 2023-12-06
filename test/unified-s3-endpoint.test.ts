import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { App, Aspects, Stack } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import {UnifiedS3EndpointApplicationStack, UnifiedS3EndpointVpcStack} from '../lib/unified-s3-endpoint-stack';


const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;


describe('cdk-nag AwsSolutions Pack', () => {
    let stack: Stack;
    let app: App;
    // In this case we can use beforeAll() over beforeEach() since our tests
    // do not modify the state of the application
    beforeAll(() => {
        // GIVEN
        app = new App();

        const vpcStack = new UnifiedS3EndpointVpcStack(app, 'test',{
            env: { account, region },
        });

        const {
            vpc, apiVpcEndpoint, apiVpcEndpointIpAddresses,s3VpcEndpoint, s3VpcEndpointIpAddresses, kmsKey
        } = vpcStack;
        stack = new UnifiedS3EndpointApplicationStack(app, 'test2',
            {
                env: { account, region },
            description: 'ALB API Demo Stack',
            vpc,
            apiVpcEndpoint,
            apiVpcEndpointIpAddresses,
            s3VpcEndpoint,
            s3VpcEndpointIpAddresses,
            kmsKey
    });

        // WHEN
        Aspects.of(stack).add(new AwsSolutionsChecks());
    });

    // THEN
    test('No unsuppressed Warnings', () => {
        const warnings = Annotations.fromStack(stack).findWarning(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*')
        );
        expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
        const errors = Annotations.fromStack(stack).findError(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*')
        );
        expect(errors).toHaveLength(0);
    });
});