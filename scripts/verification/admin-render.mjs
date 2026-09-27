// Renders real Admin form components to static markup, so the active-range
// guard is observed in the DOM the operator actually gets rather than
// inferred from the source.
import { createJiti } from 'jiti'
import { resolve } from 'node:path'

const HERE = import.meta.dirname
const root = resolve(HERE, '../..')

const jiti = createJiti(import.meta.url, {
  alias: { '@': `${root}/src` },
  interopDefault: true,
  jsx: { runtime: 'automatic' },
})

const { renderToStaticMarkup } = await jiti.import('react-dom/server')
const load = async (path) => {
  const module = await jiti.import(`${root}/${path}`)

  return module.default ?? module
}

const DeviceFormFields = await load('src/components/admin/device-form-fields.tsx')

const BASE = { name: 'Desk A', loginName: 'desk-a', enabled: true, attributes: ['registration'] }

/** The rendered Access section for one form configuration. */
export const renderDeviceForm = ({ values = BASE, activeBadgeRange = null, idPrefix = 'edit-d1' } = {}) =>
  renderToStaticMarkup(
    DeviceFormFields({ idPrefix, values, onChange: () => undefined, activeBadgeRange }),
  )

/** Every `<input type="checkbox">` in the markup, as parsed attributes. */
export const checkboxes = (html) =>
  [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => {
    const tag = match[0]
    const id = /id="([^"]*)"/.exec(tag)?.[1] ?? ''

    return {
      id,
      attribute: id.replace(/^.*-attribute-/, ''),
      checked: tag.includes('checked=""') || tag.includes('checked>'),
      disabled: tag.includes('disabled=""') || tag.includes('disabled>'),
    }
  })
