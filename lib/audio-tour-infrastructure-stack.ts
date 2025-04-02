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
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class AudioTourInfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for storing audio files and scripts
    const contentBucket = new s3.Bucket(this, 'TensorToursContentBucket', {
      bucketName: `tensortours-content-${this.region}`,
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
    const distribution = new cloudfront.Distribution(this, 'TensorToursContentDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(contentBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });

    // DynamoDB table for caching place data
    const placesTable = new dynamodb.Table(this, 'TensorToursPlacesTable', {
      tableName: 'tensortours-places',
      partitionKey: { name: 'placeId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tourType', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt', // TTL for cache freshness
    });

    // Cognito User Pool for authentication
    const userPool = new cognito.UserPool(this, 'TensorToursUserPool', {
      userPoolName: 'tensortours-users',
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

    const userPoolClient = new cognito.UserPoolClient(this, 'TensorToursUserPoolClient', {
      userPoolClientName: 'tensortours-app-client',
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
    });

    // Backend Lambda Code Bucket
    const lambdaBucket = s3.Bucket.fromBucketName(this, 'LambdaBucket', process.env.LAMBDA_BUCKET || 'audio-tour-lambda-deployment-bucket-us-west-2');
    
    // Get Lambda version from environment variable
    // If not provided, use 'latest' which will use non-versioned files
    const lambdaVersion = process.env.LAMBDA_VERSION || 'latest';
    console.log(`Deploying with Lambda version: ${lambdaVersion}`);

    // Create Secrets Manager resources
    const googleMapsApiKeySecret = secretsmanager.Secret.fromSecretNameV2(this, 'GoogleMapsApiKey', 'google-maps-api-key');
    const openaiApiKeySecret = secretsmanager.Secret.fromSecretNameV2(this, 'OpenAIApiKey', 'openai-api-key');
    const elevenlabsApiKeySecret = secretsmanager.Secret.fromSecretNameV2(this, 'ElevenLabsApiKey', 'elevenlabs-api-key');

    // Geolocation Place Gathering Lambda
    const geolocationLambda = new lambda.Function(this, 'TensorToursGeolocationLambda', {
      functionName: 'tensortours-geolocation',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? 'geolocation.zip' : `geolocation-${lambdaVersion}.zip`),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        PLACES_TABLE_NAME: placesTable.tableName,
        GOOGLE_MAPS_API_KEY_SECRET_NAME: googleMapsApiKeySecret.secretName,
        LAMBDA_VERSION: lambdaVersion,
      },
    });
    
    // Grant the Lambda function permission to read the secret
    googleMapsApiKeySecret.grantRead(geolocationLambda);

    // Audio Tour Generation Lambda
    const audioGenerationLambda = new lambda.Function(this, 'TensorToursAudioGenerationLambda', {
      functionName: 'tensortours-audio-generation',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? 'audio-generation.zip' : `audio-generation-${lambdaVersion}.zip`),
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(5), // Longer timeout for API calls and processing
      memorySize: 1024, // More memory for processing audio
      environment: {
        CONTENT_BUCKET_NAME: contentBucket.bucketName,
        OPENAI_API_KEY_SECRET_NAME: openaiApiKeySecret.secretName,
        ELEVENLABS_API_KEY_SECRET_NAME: elevenlabsApiKeySecret.secretName,
        GOOGLE_MAPS_API_KEY_SECRET_NAME: googleMapsApiKeySecret.secretName,
        CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
        LAMBDA_VERSION: lambdaVersion,
      },
    });
    
    // Grant the Lambda function permission to read the secrets
    openaiApiKeySecret.grantRead(audioGenerationLambda);
    elevenlabsApiKeySecret.grantRead(audioGenerationLambda);
    googleMapsApiKeySecret.grantRead(audioGenerationLambda);

    // Grant permissions
    contentBucket.grantReadWrite(audioGenerationLambda);
    placesTable.grantReadWriteData(geolocationLambda);

    // API Gateway
    const api = new apigateway.RestApi(this, 'TensorToursAPI', {
      restApiName: 'tensortours-api',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // Authorizer for protected endpoints
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'TensorToursAuthorizer', {
      authorizerName: 'tensortours-cognito-authorizer',
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
    new cdk.CfnOutput(this, 'TensorToursUserPoolId', {
      value: userPool.userPoolId,
    });
    
    new cdk.CfnOutput(this, 'TensorToursUserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });
    
    new cdk.CfnOutput(this, 'TensorToursApiEndpoint', {
      value: api.url,
    });
    
    new cdk.CfnOutput(this, 'TensorToursContentDistribution', {
      value: distribution.distributionDomainName,
    });
  }
}
