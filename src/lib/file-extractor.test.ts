import { describe, expect, it } from 'vitest'
import { Document, Packer, Paragraph } from 'docx'
import { extractText } from './file-extractor'

describe('workspace rich document extraction', () => {
  it('extracts real Word document text for indexing and Agent reads', async () => {
    const document = new Document({
      sections: [{ children: [new Paragraph('客户需要统一的数据治理平台')] }],
    })
    const blob = await Packer.toBlob(document)
    const file = new File(
      [blob],
      '客户需求.docx',
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    )

    await expect(extractText(file)).resolves.toContain('统一的数据治理平台')
  })
})
