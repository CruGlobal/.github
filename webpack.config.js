const path = require('path')
const TerserPlugin = require('terser-webpack-plugin')
const LicenseWebpackPlugin = require('license-webpack-plugin').LicenseWebpackPlugin

module.exports = {
  mode: 'production',
  target: 'node',
  entry: {
    'deploy-ecs': './src/deploy-ecs.js',
    'secrets': './src/secrets.js',
    'setup-env': './src/setup-env.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist')
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
    ],
    usedExports: true
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
