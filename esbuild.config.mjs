import * as esbuild from 'esbuild'
import esbuildPluginLicense from 'esbuild-plugin-license'

const handlerMap = {
    './src/build-number.js': 'build-number',
    './src/deploy-cloudrun.js': 'deploy-cloudrun',
    './src/deploy-ecs.js': 'deploy-ecs',
    './src/deploy-lambda.js': 'deploy-lambda',
    './src/docker-network.js': 'docker-network',
    './src/gcp-secrets.js': 'gcp-secrets',
    './src/secrets.js': 'secrets',
    './src/setup-env.js': 'setup-env',
    './src/trigger-deploy.js': 'trigger-deploy'
}

// Build each action as a separate bundle with flat output
for (const [input, output] of Object.entries(handlerMap)) {
    await esbuild.build({
        entryPoints: [input],
        bundle: true,
        platform: 'node',
        target: 'node22',
        outfile: `dist/${output}.js`,
        sourcemap: true,
        plugins: [
            esbuildPluginLicense({
                thirdParty: {
                    output: {
                        file: `dist/${output}.licenses.txt`,
                    }
                }
            })
        ]
    })
}

console.log(`Built ${Object.keys(handlerMap).length} actions`)
