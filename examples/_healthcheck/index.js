'use strict'

/** Generated by Serverless HealthCheck Plugin at 2020-01-01T22:27:38.387Z */
const AWS = require('aws-sdk')
AWS.config.region = 'us-east-1'
const functionObjects = JSON.parse('[{\"name\":\"http-example-dev-hello\",\"checks\":[{\"method\":\"get\",\"format\":{\"name\":\"GET: Basic Function call\"}}]},{\"name\":\"http-example-dev-helloWithParameters\",\"checks\":[{\"params\":{\"id\":\"test world\"},\"method\":\"get\",\"format\":{\"name\":\"GET: Function with path parameters\"}}]},{\"name\":\"http-example-dev-helloWithBody\",\"checks\":[{\"params\":{\"hello\":\"test world\"},\"method\":\"post\",\"format\":{\"name\":\"POST: Function with body\"}}]}]')


const lambda = new AWS.Lambda({
  region: 'us-east-1',
  endpoint: process.env.IS_OFFLINE ? "http://localhost:3002" : undefined
});


module.exports.healthCheck = (event, context, callback) => {
  let invokes = []
  let checkResponses = []
  let errors = 0

  console.log('Health Check Start')
  
  functionObjects.forEach((functionObject) => {
    functionObject.checks.forEach((check) => {
      var payload = undefined;
      switch (functionObject.checks[0].method) {
        case 'get':
            payload = JSON.stringify({pathParameters: check.params});
          break;
        case 'post':
            payload = JSON.stringify({body: check.params});
          break;
        default:
            payload = JSON.stringify({pathParameters: check.params});
          break;
      }

      const params = {
        FunctionName: functionObject.name,
        InvocationType: 'RequestResponse',
        LogType: 'None',
        Qualifier: process.env.SERVERLESS_ALIAS || '$LATEST',
        Payload: payload
      }
      
      invokes.push(lambda.invoke(params).promise().then((data) => {
        const response = JSON.parse(data.Payload)
        const statusCode = response.statusCode || ''
        const errorMessage = response.errorMessage || JSON.parse(response.body) || 'Data was returned'
        const checkBody = check.format

        checkBody.ok = statusCode === 200
        checkBody.checkOutput = errorMessage
        checkBody.lastUpdated = new Date().toISOString()

        if (response.errorMessage) {
          errors++
        }
        console.log('Health Check Event Invoke: ' + functionObject.name + '(' + JSON.stringify(check.params) + '): ' + statusCode + ' ' + errorMessage)
        checkResponses.push(checkBody)

      }, (error) => {
        errors++
        console.log('Health Check Event Invoke Error: ' + functionObject.name, error)
        const checkBody = check.format
        checkBody.ok = false
        checkBody.checkOutput = error
        checkBody.lastUpdated = new Date().toISOString()
        checkResponses.push(checkBody)
      }))
    })
  })

  Promise.all(invokes).then(() => {
    console.log('Health Check Finished with ' + errors + ' invoke errors')
    const healthBody = JSON.parse('{\"schemaVersion\":1,\"name\":\"Healthcheck system for http-example\",\"systemCode\":\"http-example\",\"checks\":[]}')
    healthBody.checks = checkResponses
    callback(null, {
      statusCode: 200,
      body: JSON.stringify(healthBody),
      headers: {
        'Content-Type': 'application/json'
      }
    })
  })
  
}