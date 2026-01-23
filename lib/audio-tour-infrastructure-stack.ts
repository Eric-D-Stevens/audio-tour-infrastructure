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
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as budgets from 'aws-cdk-lib/aws-budgets';

// CDN access key for CloudFront validation
const TENSORTOURS_CDN_KEY = 'tt-cdn-2026-xK9mP2vL8nQ4';

// ============================================================================
// COST CONTROL CONFIGURATION
// Adjust these values to tune spending limits and alerts for your usage
// ============================================================================

const COST_CONFIG = {
  // Monthly budget in USD - alerts triggered at 50%, 80%, 100%
  MONTHLY_BUDGET_USD: 500,
  BUDGET_ALERT_THRESHOLDS: [50, 80, 100], // percentages

  // API Gateway throttling (requests per second)
  API_RATE_LIMIT: 100,        // sustained requests/second
  API_BURST_LIMIT: 200,       // burst capacity

  // Lambda concurrency limits (max concurrent executions)
  LAMBDA_CONCURRENCY: {
    PHOTO_RETRIEVER: 100,      // Google Places API calls
    SCRIPT_GENERATOR: 100,     // OpenAI API calls (~$0.01-0.03 each)
    AUDIO_GENERATOR: 100,      // AWS Polly calls (~$0.004 each)
    ON_DEMAND_TOUR: 50,       // Most expensive - script + audio (~$0.05+ each)
  },

  // CloudWatch alarm thresholds
  ALARMS: {
    // CloudFront
    CLOUDFRONT_BYTES_PER_DAY: 50 * 1024 * 1024 * 1024,  // 50 GB (~2500 audio streams)
    CLOUDFRONT_REQUESTS_PER_HOUR: 10000,

    // Lambda invocations per hour
    AUDIO_GEN_INVOCATIONS_PER_HOUR: 500,
    SCRIPT_GEN_INVOCATIONS_PER_HOUR: 500,
    ON_DEMAND_TOUR_INVOCATIONS_PER_HOUR: 200,

    // Error and capacity thresholds
    LAMBDA_ERROR_RATE_PERCENT: 10,
    DYNAMODB_READ_CAPACITY_PER_MINUTE: 1000,
    DLQ_MESSAGE_THRESHOLD: 5,
  },
};

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
      lifecycleRules: [
        {
          id: 'TempFilesExpirationRule',
          prefix: 'temp/', // Only applies to objects with this prefix
          expiration: cdk.Duration.days(1), // Files expire after 7 days
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1), // Cleanup incomplete uploads
        }
      ],
    });

    // CloudFront Function to validate app API key
    // This provides a basic deterrent against unauthorized access to CDN content
    const appKeyValidationFunction = new cloudfront.Function(this, 'TensorToursAppKeyValidation', {
      functionName: 'tensortours-app-key-validation',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var headers = request.headers;
  
  // Check for the app key header
  var appKey = headers['x-tensortours-key'];
  
  // Validate the key (this key should match what's in the app)
  if (!appKey || appKey.value !== '${TENSORTOURS_CDN_KEY}') {
    return {
      statusCode: 403,
      statusDescription: 'Forbidden',
      headers: {
        'content-type': { value: 'text/plain' }
      },
      body: 'Access denied'
    };
  }
  
  // Valid key - allow request to proceed
  return request;
}
      `),
    });

    // CloudFront distribution for audio content delivery
    const distribution = new cloudfront.Distribution(this, 'TensorToursContentDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(contentBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{
          function: appKeyValidationFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
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
      customAttributes: {
        // Custom attribute for storing privacy policy version the user agreed to
        'policyVersion': new cognito.StringAttribute({ mutable: true }),
        // Custom attribute for storing timestamp when user consented to privacy policy
        'consentDate': new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      userVerification: {
        emailSubject: 'Verify your TensorTours account',
        emailBody: 'Welcome to TensorTours! Your AI-powered audio tour guide awaits. Please verify your email address by entering this code in the app: {####}',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      userInvitation: {
        emailSubject: 'Welcome to TensorTours!',
        emailBody: 'You have been invited to join TensorTours. Your username is {username} and your temporary password is {####}',
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
      accessTokenValidity: cdk.Duration.minutes(300),
      idTokenValidity: cdk.Duration.minutes(300),
      refreshTokenValidity: cdk.Duration.days(365), // 1 year token validity
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
      visibilityTimeout: cdk.Duration.minutes(1), // Set to match the lambda timeout
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'TTGenerationPhotoDLQ', {
          queueName: 'TTGenerationPhotoDLQ',
          retentionPeriod: cdk.Duration.days(14),
        }),
        maxReceiveCount: 3
      },
    });
    
    // SQS Queue for script generation with 3x retry policy
    const generationScriptQueue = new sqs.Queue(this, 'TTGenerationScriptQueue', {
      queueName: 'TTGenerationScriptQueue',
      visibilityTimeout: cdk.Duration.minutes(1), // Set to match the lambda timeout
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'TTGenerationScriptDLQ', {
          queueName: 'TTGenerationScriptDLQ',
          retentionPeriod: cdk.Duration.days(14),
        }),
        maxReceiveCount: 3
      },
    });
    
    // SQS Queue for audio generation with 3x retry policy
    const generationAudioQueue = new sqs.Queue(this, 'TTGenerationAudioQueue', {
      queueName: 'TTGenerationAudioQueue',
      visibilityTimeout: cdk.Duration.minutes(1), // Set to match the lambda timeout
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'TTGenerationAudioDLQ', {
          queueName: 'TTGenerationAudioDLQ',
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
    
    // Get Tour Lambda - for retrieving generated tour content
    const getTourLambda = new lambda.Function(this, 'TTGetTourFunction', {
      functionName: 'TTGetTourFunction',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.GET_TOUR_HANDLER || 'tensortours.lambda_handlers.get_tour.handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        TOUR_TABLE_NAME: tourTable.tableName,
        LAMBDA_VERSION: lambdaVersion,
        USER_EVENT_TABLE_NAME: userEventTable.tableName,
      },
    });
    
    // Get Preview Tour Lambda - for retrieving preview content (no auth required)
    const getPreviewTourLambda = new lambda.Function(this, 'TTGetPreviewTourFunction', {
      functionName: 'TTGetPreviewTourFunction',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.GET_PREVIEW_HANDLER || 'tensortours.lambda_handlers.get_preview.handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        TOUR_TABLE_NAME: tourTable.tableName,
        LAMBDA_VERSION: lambdaVersion,
        CONTENT_BUCKET_NAME: contentBucket.bucketName,
        CONTENT_CLOUDFRONT_DOMAIN: process.env.CONTENT_CLOUDFRONT_DOMAIN || 'd2g5o5njd6p5e.cloudfront.net',
        USER_EVENT_TABLE_NAME: userEventTable.tableName,
      },
    });
    
    // Grant the Lambda function permission to read the secret
    googleMapsApiKeySecret.grantRead(geolocationLambda);
    googleMapsApiKeySecret.grantRead(getPlacesLambda);

    // Photo Retriever Lambda for the Tour Generation Pipeline
    const photoRetrieverLambda = new lambda.Function(this, 'TTPhotoRetrieverFunction', {
      functionName: 'TTPhotoRetrieverFunction',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.PHOTO_RETRIEVER_HANDLER || 'tensortours.lambda_handlers.tour_generation_pipeline.photo_retriever_handler',
      timeout: cdk.Duration.minutes(1),
      memorySize: 512,
      // This sets a ceiling, not a floor - instances will scale from 0 based on actual demand
      reservedConcurrentExecutions: COST_CONFIG.LAMBDA_CONCURRENCY.PHOTO_RETRIEVER,
      environment: {
        TOUR_TABLE_NAME: tourTable.tableName,
        CONTENT_BUCKET: contentBucket.bucketName,
        CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
        SCRIPT_QUEUE_URL: generationScriptQueue.queueUrl,
        GOOGLE_MAPS_API_KEY_SECRET_NAME: googleMapsApiKeySecret.secretName,
        LAMBDA_VERSION: lambdaVersion,
      },
    });

    // Script Generator Lambda for the Tour Generation Pipeline
    const scriptGeneratorLambda = new lambda.Function(this, 'TTScriptGeneratorFunction', {
      functionName: 'TTScriptGeneratorFunction',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.SCRIPT_GENERATOR_HANDLER || 'tensortours.lambda_handlers.tour_generation_pipeline.script_generator_handler',
      timeout: cdk.Duration.minutes(1),
      memorySize: 512,
      // Limit concurrency for cost control - OpenAI API calls are expensive (~$0.01-0.03 per call)
      reservedConcurrentExecutions: COST_CONFIG.LAMBDA_CONCURRENCY.SCRIPT_GENERATOR,
      environment: {
        TOUR_TABLE_NAME: tourTable.tableName,
        CONTENT_BUCKET: contentBucket.bucketName,
        CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
        AUDIO_QUEUE_URL: generationAudioQueue.queueUrl,
        OPENAI_API_KEY_SECRET_NAME: openaiApiKeySecret.secretName,
        LAMBDA_VERSION: lambdaVersion,
      },
    });

    // Audio Generator Lambda for the Tour Generation Pipeline
    const audioGeneratorLambda = new lambda.Function(this, 'TTAudioGeneratorFunction', {
      functionName: 'TTAudioGeneratorFunction',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.AUDIO_GENERATOR_HANDLER || 'tensortours.lambda_handlers.tour_generation_pipeline.audio_generator_handler',
      timeout: cdk.Duration.minutes(1),
      memorySize: 512,
      // Set maximum concurrency limit to comply with AWS Polly generative voice concurrency limits
      // This sets a ceiling, not a floor - instances will scale from 0 based on actual demand
      reservedConcurrentExecutions: COST_CONFIG.LAMBDA_CONCURRENCY.AUDIO_GENERATOR,
      environment: {
        TOUR_TABLE_NAME: tourTable.tableName,
        CONTENT_BUCKET: contentBucket.bucketName,
        CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
        LAMBDA_VERSION: lambdaVersion,
      },
    });

    // Audio Tour Generation Lambda (old lambda for reference)
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
    
    // Grant permissions for the Get Tour Lambda
    tourTable.grantReadWriteData(getTourLambda);
    userEventTable.grantReadWriteData(getTourLambda);
    
    // Grant permissions for the Get Preview Tour Lambda (read-only access)
    tourTable.grantReadData(getPreviewTourLambda);
    userEventTable.grantReadWriteData(getPreviewTourLambda);
    contentBucket.grantRead(getPreviewTourLambda);
    
    // Connect queues to Lambda functions via event source mappings
    // Photo Retriever Lambda is triggered by the Photo Queue
    new lambda.EventSourceMapping(this, 'PhotoQueueToPhotoRetrieverMapping', {
      target: photoRetrieverLambda,
      eventSourceArn: generationPhotoQueue.queueArn,
      batchSize: 1, // Process one message at a time
    });

    // Script Generator Lambda is triggered by the Script Queue
    new lambda.EventSourceMapping(this, 'ScriptQueueToScriptGeneratorMapping', {
      target: scriptGeneratorLambda,
      eventSourceArn: generationScriptQueue.queueArn,
      batchSize: 1, // Process one message at a time
    });
    
    // Audio Generator Lambda is triggered by the Audio Queue
    new lambda.EventSourceMapping(this, 'AudioQueueToAudioGeneratorMapping', {
      target: audioGeneratorLambda,
      eventSourceArn: generationAudioQueue.queueArn,
      batchSize: 1, // Process one message at a time
    });
    
    // Grant necessary permissions for the pipeline Lambdas
    // Photo Retriever Lambda permissions
    googleMapsApiKeySecret.grantRead(photoRetrieverLambda);
    tourTable.grantReadWriteData(photoRetrieverLambda);
    contentBucket.grantReadWrite(photoRetrieverLambda);
    generationScriptQueue.grantSendMessages(photoRetrieverLambda);
    // Grant the Photo Retriever Lambda permission to receive messages from the Photo Queue
    generationPhotoQueue.grantConsumeMessages(photoRetrieverLambda);
    
    // Script Generator Lambda permissions
    openaiApiKeySecret.grantRead(scriptGeneratorLambda);
    tourTable.grantReadWriteData(scriptGeneratorLambda);
    contentBucket.grantReadWrite(scriptGeneratorLambda);
    generationAudioQueue.grantSendMessages(scriptGeneratorLambda);
    // Grant the Script Generator Lambda permission to receive messages from the Script Queue
    generationScriptQueue.grantConsumeMessages(scriptGeneratorLambda);
    
    // Audio Generator Lambda permissions
    tourTable.grantReadWriteData(audioGeneratorLambda);
    contentBucket.grantReadWrite(audioGeneratorLambda);
    // Grant the Audio Generator Lambda permission to receive messages from the Audio Queue
    generationAudioQueue.grantConsumeMessages(audioGeneratorLambda);
    
    // Grant AWS Polly speech synthesis permissions to the Audio Generator Lambda
    const pollyPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'polly:SynthesizeSpeech',
        'polly:StartSpeechSynthesisTask',
        'polly:GetSpeechSynthesisTask',
        'polly:ListSpeechSynthesisTasks'
      ],
      resources: ['*']
    });
    audioGeneratorLambda.addToRolePolicy(pollyPolicy);
    
    // Grant permissions for legacy Lambdas
    contentBucket.grantReadWrite(audioGenerationLambda);
    placesTable.grantReadWriteData(audioGenerationLambda); // Grant DynamoDB access to audio-generation Lambda
    placesTable.grantReadWriteData(geolocationLambda);
    
    // Grant AWS Polly speech synthesis permissions to the Audio Generation Lambda
    audioGenerationLambda.addToRolePolicy(pollyPolicy);
    
    // Grant the tour preview Lambda permission to invoke other Lambdas
    geolocationLambda.grantInvoke(tourPreviewLambda);
    getPlacesLambda.grantInvoke(tourPreviewLambda);
    audioGenerationLambda.grantInvoke(tourPreviewLambda);

    // API Gateway with throttling for cost control
    // 100 concurrent users * ~10 requests/minute = 1000 requests/minute max
    const api = new apigateway.RestApi(this, 'TensorToursAPI', {
      restApiName: 'tensortours-api',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
      deployOptions: {
        // Stage-level throttling for cost control
        throttlingRateLimit: COST_CONFIG.API_RATE_LIMIT,
        throttlingBurstLimit: COST_CONFIG.API_BURST_LIMIT,
        // Enable CloudWatch logging for monitoring
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
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
    const previewResource = api.root.addResource('getPreview');
    const cityResource = previewResource.addResource('{city}');
    cityResource.addMethod('GET', new apigateway.LambdaIntegration(tourPreviewLambda));
    
    // Preview tour endpoint (no auth) - for retrieving preview tour data
    const previewTourResource = api.root.addResource('getPreviewTour');
    previewTourResource.addMethod('POST', new apigateway.LambdaIntegration(getPreviewTourLambda), {
      authorizationType: apigateway.AuthorizationType.NONE, // No auth required for previews
    });

    // Audio generation API
    const audioResource = api.root.addResource('audio');
    const placeResource = audioResource.addResource('{placeId}');
    placeResource.addMethod('GET', new apigateway.LambdaIntegration(audioGenerationLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    
    // Get Tour API (authenticated)
    const getTourResource = api.root.addResource('getTour');
    getTourResource.addMethod('POST', new apigateway.LambdaIntegration(getTourLambda), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Get On-Demand Tour Lambda - for retrieving on-demand generated tour content
    // This is the most expensive Lambda as it does both script (OpenAI) + audio (Polly) generation
    const getOnDemandTourLambda = new lambda.Function(this, 'TTGetOnDemandTourFunction', {
      functionName: 'TTGetOnDemandTourFunction',
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromBucket(lambdaBucket, lambdaVersion === 'latest' ? lambdaPackage : lambdaPackage),
      handler: process.env.GET_ON_DEMAND_TOUR_HANDLER || 'tensortours.lambda_handlers.get_on_demand_tour.handler',
      timeout: cdk.Duration.minutes(2), // Longer timeout as it may involve on-demand generation
      memorySize: 512, // More memory for processing
      // Strict concurrency limit - this is the most expensive operation (~$0.05+ per call)
      reservedConcurrentExecutions: COST_CONFIG.LAMBDA_CONCURRENCY.ON_DEMAND_TOUR,
      environment: {
        TOUR_TABLE_NAME: tourTable.tableName,
        CONTENT_BUCKET: contentBucket.bucketName,
        CLOUDFRONT_DOMAIN: distribution.distributionDomainName,
        LAMBDA_VERSION: lambdaVersion,
        USER_EVENT_TABLE_NAME: userEventTable.tableName,
        GOOGLE_MAPS_API_KEY_SECRET_NAME: googleMapsApiKeySecret.secretName,
        OPENAI_API_KEY_SECRET_NAME: openaiApiKeySecret.secretName,
      },
    });

    // Grant necessary permissions for the Get On-Demand Tour Lambda
    tourTable.grantReadWriteData(getOnDemandTourLambda);
    userEventTable.grantReadWriteData(getOnDemandTourLambda);
    contentBucket.grantReadWrite(getOnDemandTourLambda);
    googleMapsApiKeySecret.grantRead(getOnDemandTourLambda);
    openaiApiKeySecret.grantRead(getOnDemandTourLambda);
    
    // Grant AWS Polly speech synthesis permissions to the Get On-Demand Tour Lambda
    getOnDemandTourLambda.addToRolePolicy(pollyPolicy);

    // Get On-Demand Tour API (authenticated)
    const getOnDemandTourResource = api.root.addResource('getOnDemandTour');
    getOnDemandTourResource.addMethod('POST', new apigateway.LambdaIntegration(getOnDemandTourLambda), {
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
    
    new cdk.CfnOutput(this, 'TTGenerationScriptQueueUrl', {
      value: generationScriptQueue.queueUrl,
    });
    
    new cdk.CfnOutput(this, 'TTGenerationAudioQueueUrl', {
      value: generationAudioQueue.queueUrl,
    });

    // ============================================================================
    // COST CONTROLS AND MONITORING
    // Designed for ~100 simultaneous users with sensible transfer limits
    // ============================================================================

    // SNS Topic for cost/usage alerts
    const alertTopic = new sns.Topic(this, 'TensorToursCostAlerts', {
      topicName: 'tensortours-cost-alerts',
      displayName: 'TensorTours Cost and Usage Alerts',
    });

    // Subscribe email and SMS for alert notifications
    alertTopic.addSubscription(new snsSubscriptions.EmailSubscription('e.stevens@tensorworks.co'));
    alertTopic.addSubscription(new snsSubscriptions.SmsSubscription('+13109993742'));

    // Monthly budget alarm with configurable thresholds
    const monthlyBudget = new budgets.CfnBudget(this, 'TensorToursMonthlyBudget', {
      budget: {
        budgetName: 'TensorTours-Monthly-Budget',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: COST_CONFIG.MONTHLY_BUDGET_USD,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers: COST_CONFIG.BUDGET_ALERT_THRESHOLDS.map(threshold => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold: threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'SNS', address: alertTopic.topicArn }],
      })),
    });

    // CloudFront data transfer alarm
    const cloudfrontBytesOutAlarm = new cloudwatch.Alarm(this, 'CloudFrontBytesOutAlarm', {
      alarmName: 'TensorTours-CloudFront-HighDataTransfer',
      alarmDescription: `CloudFront data transfer exceeds ${COST_CONFIG.ALARMS.CLOUDFRONT_BYTES_PER_DAY / (1024 * 1024 * 1024)}GB in 24 hours`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName: 'BytesDownloaded',
        dimensionsMap: {
          DistributionId: distribution.distributionId,
          Region: 'Global',
        },
        statistic: 'Sum',
        period: cdk.Duration.hours(24),
      }),
      threshold: COST_CONFIG.ALARMS.CLOUDFRONT_BYTES_PER_DAY,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cloudfrontBytesOutAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // CloudFront request count alarm
    const cloudfrontRequestsAlarm = new cloudwatch.Alarm(this, 'CloudFrontRequestsAlarm', {
      alarmName: 'TensorTours-CloudFront-HighRequests',
      alarmDescription: `CloudFront requests exceed ${COST_CONFIG.ALARMS.CLOUDFRONT_REQUESTS_PER_HOUR} per hour`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName: 'Requests',
        dimensionsMap: {
          DistributionId: distribution.distributionId,
          Region: 'Global',
        },
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: COST_CONFIG.ALARMS.CLOUDFRONT_REQUESTS_PER_HOUR,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cloudfrontRequestsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // Audio Generator Lambda invocation alarm
    // Each audio generation costs ~$0.004 (Polly generative) + Lambda execution
    const audioGenInvocationsAlarm = new cloudwatch.Alarm(this, 'AudioGenInvocationsAlarm', {
      alarmName: 'TensorTours-AudioGen-HighInvocations',
      alarmDescription: `Audio generation Lambda invocations exceed ${COST_CONFIG.ALARMS.AUDIO_GEN_INVOCATIONS_PER_HOUR} per hour`,
      metric: audioGeneratorLambda.metricInvocations({
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: COST_CONFIG.ALARMS.AUDIO_GEN_INVOCATIONS_PER_HOUR,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    audioGenInvocationsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // Script Generator Lambda invocation alarm
    // OpenAI GPT-4o costs ~$0.01-0.03 per script generation
    const scriptGenInvocationsAlarm = new cloudwatch.Alarm(this, 'ScriptGenInvocationsAlarm', {
      alarmName: 'TensorTours-ScriptGen-HighInvocations',
      alarmDescription: `Script generation Lambda invocations exceed ${COST_CONFIG.ALARMS.SCRIPT_GEN_INVOCATIONS_PER_HOUR} per hour`,
      metric: scriptGeneratorLambda.metricInvocations({
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: COST_CONFIG.ALARMS.SCRIPT_GEN_INVOCATIONS_PER_HOUR,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    scriptGenInvocationsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // On-Demand Tour Lambda alarm - most expensive as it does both script + audio
    const onDemandTourInvocationsAlarm = new cloudwatch.Alarm(this, 'OnDemandTourInvocationsAlarm', {
      alarmName: 'TensorTours-OnDemandTour-HighInvocations',
      alarmDescription: `On-demand tour generation exceeds ${COST_CONFIG.ALARMS.ON_DEMAND_TOUR_INVOCATIONS_PER_HOUR} per hour`,
      metric: getOnDemandTourLambda.metricInvocations({
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: COST_CONFIG.ALARMS.ON_DEMAND_TOUR_INVOCATIONS_PER_HOUR,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    onDemandTourInvocationsAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // Lambda error rate alarms - detect issues early
    const lambdaErrorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorRateAlarm', {
      alarmName: 'TensorTours-Lambda-HighErrorRate',
      alarmDescription: `Lambda error rate exceeds ${COST_CONFIG.ALARMS.LAMBDA_ERROR_RATE_PERCENT}% over 15 minutes`,
      metric: new cloudwatch.MathExpression({
        expression: 'errors / invocations * 100',
        usingMetrics: {
          errors: audioGeneratorLambda.metricErrors({ statistic: 'Sum', period: cdk.Duration.minutes(15) }),
          invocations: audioGeneratorLambda.metricInvocations({ statistic: 'Sum', period: cdk.Duration.minutes(15) }),
        },
        period: cdk.Duration.minutes(15),
      }),
      threshold: COST_CONFIG.ALARMS.LAMBDA_ERROR_RATE_PERCENT,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // DynamoDB consumed capacity alarm - detect unexpected read/write spikes
    const dynamoReadCapacityAlarm = new cloudwatch.Alarm(this, 'DynamoReadCapacityAlarm', {
      alarmName: 'TensorTours-DynamoDB-HighReadCapacity',
      alarmDescription: `DynamoDB read capacity exceeds ${COST_CONFIG.ALARMS.DYNAMODB_READ_CAPACITY_PER_MINUTE} RCU per minute`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ConsumedReadCapacityUnits',
        dimensionsMap: {
          TableName: tourTable.tableName,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: COST_CONFIG.ALARMS.DYNAMODB_READ_CAPACITY_PER_MINUTE,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dynamoReadCapacityAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // SQS Dead Letter Queue alarm - detect failed message processing
    const dlqMessagesAlarm = new cloudwatch.Alarm(this, 'DLQMessagesAlarm', {
      alarmName: 'TensorTours-DLQ-MessagesVisible',
      alarmDescription: 'Messages in Dead Letter Queue indicate processing failures',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateNumberOfMessagesVisible',
        dimensionsMap: {
          QueueName: 'TTGenerationAudioDLQ',
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: COST_CONFIG.ALARMS.DLQ_MESSAGE_THRESHOLD,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqMessagesAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // Output the alert topic ARN for subscription
    new cdk.CfnOutput(this, 'CostAlertTopicArn', {
      value: alertTopic.topicArn,
      description: 'Subscribe to this SNS topic to receive cost and usage alerts',
    });
  }
}
