import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';

export class AudioTourInfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for storing audio files and scripts
    const contentBucket = new s3.Bucket(this, 'AudioTourContentBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
          ],
          allowedOrigins: ['*'], // Lock this down in production
          allowedHeaders: ['*'],
        },
      ],
    });

    // CloudFront distribution for audio content delivery
    const distribution = new cloudfront.Distribution(this, 'AudioTourDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(contentBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });

    // DynamoDB table for caching place data
    const placesTable = new dynamodb.Table(this, 'PlacesTable', {
      partitionKey: { name: 'placeId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tourType', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt', // TTL for cache freshness
    });

    // Cognito User Pool for authentication
    const userPool = new cognito.UserPool(this, 'AudioTourUserPool', {
      selfSignUpEnabled: true,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'AudioTourUserPoolClient', {
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
    });

    // Geolocation Place Gathering Lambda
    const geolocationLambda = new lambda.Function(this, 'GeolocationLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/geolocation'),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        PLACES_TABLE_NAME: placesTable.tableName,
        GOOGLE_MAPS_API_KEY: cdk.SecretValue.secretsManager('google-maps-api-key').toString(),
      },
    });

    // Audio Tour Generation Lambda
    const audioGenerationLambda = new lambda.Function(this, 'AudioGenerationLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      code: lambda.Code.fromAsset('lambda/audio-generation'),
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(5), // Longer timeout for API calls and processing
      memorySize: 1024, // More memory for processing audio
      environment: {
        CONTENT_BUCKET_NAME: contentBucket.bucketName,
        OPENAI_API_KEY: cdk.SecretValue.secretsManager('openai-api-key').toString(),
        ELEVENLABS_API_KEY: cdk.SecretValue.secretsManager('elevenlabs-api-key').toString(),
        CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
      },
    });

    // Grant permissions
    contentBucket.grantReadWrite(audioGenerationLambda);
    placesTable.grantReadWriteData(geolocationLambda);

    // API Gateway
    const api = new apigateway.RestApi(this, 'AudioTourAPI', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // Authorizer for protected endpoints
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'AudioTourAuthorizer', {
      cognitoUserPools: [userPool],
    });

    // Geolocation API
    const geoResource = api.root.addResource('places');
    geoResource.addMethod('GET', new apigateway.LambdaIntegration(geolocationLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Public preview endpoint (no auth)
    const previewResource = api.root.addResource('preview');
    const cityResource = previewResource.addResource('{city}');
    cityResource.addMethod('GET', new apigateway.LambdaIntegration(geolocationLambda));

    // Audio generation API
    const audioResource = api.root.addResource('audio');
    const placeResource = audioResource.addResource('{placeId}');
    placeResource.addMethod('GET', new apigateway.LambdaIntegration(audioGenerationLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Public audio preview endpoint
    const audioPreviewResource = previewResource.addResource('audio');
    const previewPlaceResource = audioPreviewResource.addResource('{placeId}');
    previewPlaceResource.addMethod('GET', new apigateway.LambdaIntegration(audioGenerationLambda));

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
    });
    
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });
    
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
    });
    
    new cdk.CfnOutput(this, 'ContentDistribution', {
      value: distribution.distributionDomainName,
    });
  }
}
