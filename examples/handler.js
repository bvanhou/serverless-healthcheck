'use strict'

const { stringify } = JSON

exports.hello = async function hello() {
  return {
    body: stringify({ message: 'success' }),
    statusCode: 200,
  }
}

exports.helloWithParameters = async function helloWithParameters(event, context) {
  return {
    body: stringify({ id: event.pathParameters.id }),
    statusCode: 200,
  }
}

exports.helloWithBody = async function helloWithBody(event, context) {
  return {
    body: stringify(event.body),
    statusCode: 200,
  }
}