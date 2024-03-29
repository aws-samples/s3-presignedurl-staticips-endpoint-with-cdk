export const options = {
    certificateArn: 'EPLACE-WITH-YOUR-ACM-ARN',
    dnsAttr: {
        zoneName: 'REPLACE-WITH-YOUR-ZONENAME(example.com)',
        hostedZoneId: 'REPLACE-WITH-YOUR-HOSTEDZONEID',
    },
    domainNamePrefix: 's3-endpoint',
    presignPath: 'presign',
    objectsPath: 'objects',
};