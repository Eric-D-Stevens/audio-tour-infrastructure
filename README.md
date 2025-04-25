# TensorTours Infrastructure

## What is TensorTours?

TensorTours is an AI-powered audio tour application that creates personalized, location-based audio guides for travelers. The app uses artificial intelligence to generate engaging, informative content about points of interest based on user preferences, location data, and available time. TensorTours enhances the travel experience by providing rich historical and cultural context through audio narration as users explore new places.

Key features include customizable tour durations, multiple tour categories (History, Art, Culture, Food & Drink, Architecture, Nature), real-time location tracking, and high-quality place photos with proper attribution.

## Infrastructure Repository Role

This repository contains the cloud infrastructure code for TensorTours, defined as Infrastructure as Code (IaC) using AWS Cloud Development Kit (CDK) with TypeScript. The infrastructure repository is responsible for:

1. **AWS Resource Provisioning**: Defining and deploying all cloud resources required by the application
2. **API Gateway Configuration**: Setting up the REST API endpoints that connect the frontend to backend services
3. **Lambda Function Deployment**: Configuring serverless functions for various microservices
4. **Database Setup**: Creating and configuring data storage resources
5. **Security Configuration**: Implementing authentication resources and permission policies
6. **CI/CD Pipeline**: Defining continuous integration and deployment workflows

### Key Components

- AWS CDK for infrastructure definition
- CloudFormation templates (synthesized from CDK code)
- CI/CD pipeline configuration
- Resource policies and security settings

### Getting Started

1. Install dependencies:
   ```
   npm install
   ```

2. Bootstrap your AWS environment (if not already done):
   ```
   npx cdk bootstrap
   ```

3. Deploy the infrastructure:
   ```
   npx cdk deploy
   ```

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
