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
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';

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
    
    // New DynamoDB table for storing tour data
    const tourTable = new dynamodb.Table(this, 'TTTourTable', {
      tableName: 'TTTourTable',
      partitionKey: { name: 'place_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tour_type', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Production setting to preserve data
    });
    
    // User Event Table for tracking user actions
    const userEventTable = new dynamodb.Table(this, 'TTUserEventTable', {
      tableName: 'TTUserEventTable',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Production setting to preserve data
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
    
    // Get Lambda version and package info from environment variables
    // If not provided, use 'latest' which will use non-versioned files
    const lambdaVersion = process.env.LAMBDA_VERSION || 'latest';
    const lambdaPackage = process.env.LAMBDA_PACKAGE || 'tensortours.zip';
    console.log(`Deploying with Lambda version: ${lambdaVersion}, package: ${lambdaPackage}`);

    // Create Secrets Manager resources
    const googleMapsApiKeySecret = secretsmanager.Secret.fromSecretNameV2(this, 'GoogleMapsApiKey', 'google-maps-api-key');
    const openaiApiKeySecret = secretsmanager.Secret.fromSecretNameV2(this, 'OpenAIApiKey', 'openai-api-key');
    const elevenlabsApiKeySecret = secretsmanager.Secret.fromSecretNameV2(this, 'ElevenLabsApiKey', 'elevenlabs-api-key');
    
    // SQS Queue for pre-generating tours
    const tourPreGenerationQueue = new sqs.Queue(this, 'TensorTourPreGenerationQueue', {
      queueName: 'tensortours-pre-generation-queue',
      visibilityTimeout: cdk.Duration.minutes(6), // Should be longer than the lambda timeout
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'TensorTourPreGenerationDLQ', {
          queueName: 'tensortours-pre-generation-dlq',
          retentionPeriod: cdk.Duration.days(14),
        }),
        maxReceiveCount: 3
      },
    });
    
    // SQS Queue for tour generation (new queue) with proper naming and 3x retry policy
    const generationPhotoQueue = new sqs.Queue(this, 'TTGenerationPhotoQueue', {
      queueName: 'TTGenerationPhotoQueue',
      visibilityTimeout: cdk.Duration.minutes(6), // Should be longer than the lambda timeout
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'TTGenerationPhotoDLQ', {
          queueName: 'TTGenerationPhotoDLQ',
          retentionPeriod: cdk.Duration.days(14),
        }),
        maxReceiveCount: 3
      },
    });

    // Geolocation Place Gathering Lambda
    const geolocationLambda = new lambda.Function(this, 'TensorToursGeolocationLambda', {
      functionName: 'tensortours-geolocation',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.GEOLOCATION_HANDLER || 'tensortours.lambda_handlers.geolocation.handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        PLACES_TABLE_NAME: placesTable.tableName,
        GOOGLE_MAPS_API_KEY_SECRET_NAME: googleMapsApiKeySecret.secretName,
        LAMBDA_VERSION: lambdaVersion,
        TOUR_PREGENERATION_QUEUE_URL: tourPreGenerationQueue.queueUrl,
      },
    });
    
    // Get Places Lambda (new Lambda to replace geolocation) with proper naming
    const getPlacesLambda = new lambda.Function(this, 'TTGetPlacesFunction', {
      functionName: 'TTGetPlacesFunction',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.GET_PLACES_HANDLER || 'tensortours.lambda_handlers.get_places.handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        TOUR_TABLE_NAME: tourTable.tableName,
        GOOGLE_MAPS_API_KEY_SECRET_NAME: googleMapsApiKeySecret.secretName,
        LAMBDA_VERSION: lambdaVersion,
        TOUR_GENERATION_QUEUE_URL: generationPhotoQueue.queueUrl,
        USER_EVENT_TABLE_NAME: userEventTable.tableName,
      },
    });
    
    // Grant the Lambda function permission to read the secret
    googleMapsApiKeySecret.grantRead(geolocationLambda);
    googleMapsApiKeySecret.grantRead(getPlacesLambda);

    // Audio Tour Generation Lambda
    const audioGenerationLambda = new lambda.Function(this, 'TensorToursAudioGenerationLambda', {
      functionName: 'tensortours-audio-generation',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.AUDIO_GENERATION_HANDLER || 'tensortours.lambda_handlers.audio_generation.handler',
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

    // Tour Pre-Generation Lambda
    const tourPreGenerationLambda = new lambda.Function(this, 'TensorTourPreGenerationLambda', {
      functionName: 'tensortours-tour-pre-generation',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.TOUR_PRE_GENERATION_HANDLER || 'tensortours.lambda_handlers.tour_pre_generation.handler',
      timeout: cdk.Duration.minutes(5), // Longer timeout for API calls and processing
      memorySize: 1024, // More memory for processing audio
      environment: {
        CONTENT_BUCKET_NAME: contentBucket.bucketName,
        OPENAI_API_KEY_SECRET_NAME: openaiApiKeySecret.secretName,
        ELEVENLABS_API_KEY_SECRET_NAME: elevenlabsApiKeySecret.secretName,
        GOOGLE_MAPS_API_KEY_SECRET_NAME: googleMapsApiKeySecret.secretName,
        CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
        LAMBDA_VERSION: lambdaVersion,
        PLACES_TABLE_NAME: placesTable.tableName,
      },
    });
    
    // Tour Preview Lambda for Guest Mode
    const tourPreviewLambda = new lambda.Function(this, 'TensorTourPreviewLambda', {
      functionName: 'tensortours-tour-preview',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.TOUR_PREVIEW_HANDLER || 'tensortours.lambda_handlers.tour_preview.handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        LAMBDA_VERSION: lambdaVersion,
      },
    });
    
    // Add SQS event source to the pre-generation lambda
    tourPreGenerationLambda.addEventSource(new lambdaEventSources.SqsEventSource(tourPreGenerationQueue, {
      batchSize: 1, // Process one message at a time
    }));
    
    // Grant the pre-generation Lambda function permission to read the secrets
    openaiApiKeySecret.grantRead(tourPreGenerationLambda);
    elevenlabsApiKeySecret.grantRead(tourPreGenerationLambda);
    googleMapsApiKeySecret.grantRead(tourPreGenerationLambda);
    
    // Grant the pre-generation Lambda function permission to read/write to S3
    contentBucket.grantReadWrite(tourPreGenerationLambda);
    
    // Grant the pre-generation Lambda function permission to read/write to DynamoDB
    placesTable.grantReadWriteData(tourPreGenerationLambda);
    
    // Grant the geolocation Lambda function permission to send messages to the SQS queue
    tourPreGenerationQueue.grantSendMessages(geolocationLambda);
    
    // Grant the get places Lambda function permission to send messages to the new Tour Generation Queue
    generationPhotoQueue.grantSendMessages(getPlacesLambda);
    
    // Grant the get places Lambda function permission to read/write to the Tour Table
    tourTable.grantReadWriteData(getPlacesLambda);
    
    // Grant the get places Lambda function permission to read/write to the User Event Table
    userEventTable.grantReadWriteData(getPlacesLambda);
    
    // Grant permissions
    contentBucket.grantReadWrite(audioGenerationLambda);
    placesTable.grantReadWriteData(audioGenerationLambda); // Grant DynamoDB access to audio-generation Lambda
    placesTable.grantReadWriteData(geolocationLambda);
    
    // Grant the tour preview Lambda permission to invoke other Lambdas
    geolocationLambda.grantInvoke(tourPreviewLambda);
    getPlacesLambda.grantInvoke(tourPreviewLambda);
    audioGenerationLambda.grantInvoke(tourPreviewLambda);

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

    // Geolocation API (legacy)
    const geoResource = api.root.addResource('places');
    geoResource.addMethod('GET', new apigateway.LambdaIntegration(geolocationLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    
    // Get Places API (new endpoint)
    const getPlacesResource = api.root.addResource('getPlaces');
    getPlacesResource.addMethod('POST', new apigateway.LambdaIntegration(getPlacesLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Public preview endpoint (no auth) - now using the tour-preview Lambda
    const previewResource = api.root.addResource('preview');
    const cityResource = previewResource.addResource('{city}');
    cityResource.addMethod('GET', new apigateway.LambdaIntegration(tourPreviewLambda));

    // Audio generation API
    const audioResource = api.root.addResource('audio');
    const placeResource = audioResource.addResource('{placeId}');
    placeResource.addMethod('GET', new apigateway.LambdaIntegration(audioGenerationLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Public audio preview endpoint - now using the tour-preview Lambda
    const audioPreviewResource = previewResource.addResource('audio');
    const previewPlaceResource = audioPreviewResource.addResource('{placeId}');
    previewPlaceResource.addMethod('GET', new apigateway.LambdaIntegration(tourPreviewLambda));

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
    
    new cdk.CfnOutput(this, 'TensorToursContentDistributionUrl', {
      value: distribution.distributionDomainName,
    });
    
    new cdk.CfnOutput(this, 'TensorTourPreGenerationQueueUrl', {
      value: tourPreGenerationQueue.queueUrl,
    });
    
    new cdk.CfnOutput(this, 'TTGenerationPhotoQueueUrl', {
      value: generationPhotoQueue.queueUrl,
    });
  }
}
