const path = require('path')
const TerserPlugin = require('terser-webpack-plugin')
const LicenseWebpackPlugin = require('license-webpack-plugin').LicenseWebpackPlugin

module.exports = {
  mode: 'production',
  target: 'node',
  entry: {
    'build-number': './src/build-number.js',
    'deploy-ecs': './src/deploy-ecs.js',
    'deploy-lambda': './src/deploy-lambda.js',
    'docker-network': './src/docker-network.js',
    'secrets': './src/secrets.js',
    'setup-env': './src/setup-env.js',
    'trigger-deploy': './src/trigger-deploy.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    chunkFormat: false
  },
  devtool: 'source-map',
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        extractComments: false,
        terserOptions: {
          format: {
            comments: false
          }
        }
      })
    ]
  },
  plugins: [
    new LicenseWebpackPlugin({
      stats: {
        warnings: false
      }
    })
  ],
  ignoreWarnings: [
    {
      message: /aws-crt/
    }
  ]
}
