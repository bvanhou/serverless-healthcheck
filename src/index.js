'use strict'

const BbPromise = require('bluebird')
const fs = BbPromise.promisifyAll(require('fs-extra'))
const path = require('path')
const tokenSubstitute = require('token-substitute')

class HealthCheck {

  constructor(serverless, options) {
    this.serverless = serverless
    this.options = options
    this.custom = this.serverless.service.custom
    this.provider = this.serverless.getProvider('aws')

    this.hooks = {
      'before:offline:start': this.beforeServerlessOffline.bind(this),
      'after:package:initialize': this.afterPackageInitialize.bind(this),
      'after:package:createDeploymentArtifacts': this.afterCreateDeploymentArtifacts.bind(this),
      'after:deploy:deploy': this.afterDeployFunctions.bind(this)
    }
  }

  beforeServerlessOffline() {
    this.serverless.cli.log('Running HealthCheck Locally');
    process.env.IS_OFFLINE = true;
    this.configPlugin()
    return this.createHealthCheck()
  }

  afterPackageInitialize() {
    this.serverless.cli.log('HealthCheck: Create Healthcheck')
    this.configPlugin()
    return this.createHealthCheck()
  }

  afterCreateDeploymentArtifacts() {
    this.serverless.cli.log('HealthCheck: Create artifacts')
    return this.cleanFolder()
  }

  afterDeployFunctions() {
    this.serverless.cli.log('HealthCheck: Deploy functions')
    this.configPlugin()
    if (this.healthcheck.precheck) {
      return this.healthCheckFunctions()
    }
  }

  configPlugin() {
    this.folderName = '_healthcheck'
    if (this.custom && this.custom.healthcheck && typeof this.custom.healthcheck.folderName === 'string') {
      this.folderName = this.custom.healthcheck.folderName
    }
    this.pathFolder = this.getPath(this.folderName)
    this.pathFile = this.pathFolder + '/index.js'
    this.pathHandler = this.folderName + '/index.healthCheck'

    /** Default options */
    this.healthcheck = {
      cleanFolder: true,
      memorySize: 128,
      name: this.serverless.service.service + '-' + this.options.stage + '-healthcheck-plugin',
      schedule: ['rate(5 minutes)'],
      timeout: 10,
      precheck: false,
      endpoint: '__health',
      format: {
        schemaVersion: 1,
        name: `Healthcheck system for ${this.serverless.service.service}`,
        systemCode: `${this.serverless.service.service}`,
        checks: []
      }
      
    }

    /** Set global custom options */
    if (!this.custom || !this.custom.healthcheck) {
      return
    }

    /** Clean folder */
    if (typeof this.custom.healthcheck.cleanFolder === 'boolean') {
      this.healthcheck.cleanFolder = this.custom.healthcheck.cleanFolder
    }

    /** Memory size */
    if (typeof this.custom.healthcheck.memorySize === 'number') {
      this.healthcheck.memorySize = this.custom.healthcheck.memorySize
    }

    /** Function name */
    if (typeof this.custom.healthcheck.name === 'string') {
      this.healthcheck.name = this.custom.healthcheck.name
    }

    /** Schedule expression */
    if (typeof this.custom.healthcheck.schedule === 'string') {
      this.healthcheck.schedule = [this.custom.healthcheck.schedule]
    } else if (Array.isArray(this.custom.healthcheck.schedule)) {
      this.healthcheck.schedule = this.custom.healthcheck.schedule
    }

    /** Timeout */
    if (typeof this.custom.healthcheck.timeout === 'number') {
      this.healthcheck.timeout = this.custom.healthcheck.timeout
    }

    /** Pre-check */
    if (typeof this.custom.healthcheck.precheck === 'boolean') {
      this.healthcheck.precheck = this.custom.healthcheck.precheck
    }

    /** Endpoint name */
    if (typeof this.custom.healthcheck.endpoint === 'string') {
      this.healthcheck.endpoint = this.custom.healthcheck.endpoint
    }

    /** Format */
    if (typeof this.custom.healthcheck.format === 'object') {
      this.healthcheck.format = this.custom.healthcheck.format
    }

  }

  getPath(file) {
    return path.join(this.serverless.config.servicePath, file)
  }

  cleanFolder() {
    if (!this.healthcheck.cleanFolder) {
      return Promise.resolve()
    }
    return fs.removeAsync(this.pathFolder)
  }

  createHealthCheck() {
    return this.getFunctionsWithHealthChecks()
      .then((functionNames) => {
        this.serverless.cli.log(`HealthCheck: ${functionNames}`)
        if (!functionNames.length) {
          this.serverless.cli.log('HealthCheck: no lambda to check')
          return true
        }

        return this.createHealthCheckFunctionArtifact(functionNames)
      }).then((skip) => {
        if (skip !== true) {
          return this.addHealthCheckFunctionToService()
        }
      })
  }

  getFunctionsWithHealthChecks() {
    const allFunctions = this.serverless.service.getAllFunctions().map((functionName) => {
      const functionObject = this.serverless.service.getFunction(functionName)
       return {
        name: functionObject.name,
        checks: this.getEventsWithHealthChecks(functionName)
      }
    })

    return BbPromise.filter(allFunctions, (functionInfo) => functionInfo.checks.length > 0 )
  }

  getEventsWithHealthChecks(functionName) {
    return this.serverless.service.getAllEventsInFunction(functionName)
      .filter((eventObject) => ('http' in eventObject && 'healthcheck' in eventObject.http))
      .reduce((healthchecks, eventObject) => {
          healthchecks.push({
            params: eventObject.http.healthcheck.params,
            method: eventObject.http.method,
            format: eventObject.http.healthcheck.format
          })
        return healthchecks
      }, [])
  }

  createHealthCheckFunctionArtifact(functionObjects) {
    this.serverless.cli.log('HealthCheck: setting ' + functionObjects.length + ' lambdas to be checked')

    functionObjects.map((functionObject) => {
      this.serverless.cli.log('HealthCheck: ' + functionObject.name)
      functionObject.checks.map((eventObject) => {
        this.serverless.cli.log('    Params: ' + JSON.stringify(eventObject.params))
      })
    })

    const healthcheckTemplate = fs.readFileSync(path.resolve(__dirname, './plugin_template.js'), 'utf8')
    const healthCheckFunction = tokenSubstitute(healthcheckTemplate, {
      tokens: {
        creationDate: new Date().toISOString(),
        awsRegion: this.serverless.service.provider.region,
        healthchecks: JSON.stringify(functionObjects),
        outputHeader: JSON.stringify(this.healthcheck.format)
      }
    })

    /** Write health check file */
    return fs.outputFileAsync(this.pathFile, healthCheckFunction)
  }

  addHealthCheckFunctionToService () {
    /** SLS health check function */
    this.serverless.cli.log(`Scheduling HealthCheck for: ${ this.healthcheck.schedule[0] }`)
    this.serverless.service.functions.healthCheckPlugin = {
      description: 'Serverless HealthCheck Plugin',
      events: [
        {
          http: {
            path: this.healthcheck.endpoint,
            method: 'get',
            private: false
          },
          schedule: {
            rate: this.healthcheck.schedule[0]
          }
        }
      ],
      handler: this.pathHandler,
      memorySize: this.healthcheck.memorySize,
      name: this.healthcheck.name,
      runtime: this.serverless.service.provider.runtime,
      package: {
        individually: true,
        exclude: ['**'],
        include: [this.folderName + '/**']
      },
      timeout: this.healthcheck.timeout
    }

    return this.serverless.service.functions.healthCheckPlugin
  }

  healthCheckFunctions () {
    this.serverless.cli.log('HealthCheck: Pre-checking up your functions')

    const params = {
      FunctionName: this.healthcheck.name,
      InvocationType: 'RequestResponse',
      LogType: 'None',
      Qualifier: process.env.SERVERLESS_ALIAS || '$LATEST',
      Payload: JSON.stringify({ source: 'serverless-plugin-healthcheck' })
    }

    return this.provider.request('Lambda', 'invoke', params)
      .then(data => {
        const response = JSON.parse(data.Payload)
        if ((response.statusCode && response.statusCode !== 200) || response.errorMessage) {
          this.serverless.cli.log('HealthCheck: Failure: ' + response.errorMessage)
        } else {
          this.serverless.cli.log('HealthCheck: Functions successfuly pre-checked')
        }
      })
      .catch(error => this.serverless.cli.log('HealthCheck: Error while pre-checking functions' + error))
  }
}

/** Export HealthCheck class */
module.exports = HealthCheck
