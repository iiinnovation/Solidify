import { describe, expect, it } from 'vitest'
import { Document, Packer, Paragraph } from 'docx'
import JSZip from 'jszip'
import { extractText, inferFileMimeType } from './file-extractor'

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

  it('extracts shared and numeric cells from XLSX workbooks', async () => {
    const zip = new JSZip()
    zip.file('xl/sharedStrings.xml', `<?xml version="1.0"?><sst><si><t>云资源名称</t></si><si><t>生产环境</t></si></sst>`)
    zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="资源清单" r:id="rId1"/></sheets></workbook>`)
    zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`)
    zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="inlineStr"><is><t>ecs-001</t></is></c><c><v>8</v></c></row></sheetData></worksheet>`)
    const blob = await zip.generateAsync({ type: 'blob' })
    const file = new File([blob], '资源清单.xlsx', { type: inferFileMimeType('资源清单.xlsx') })

    await expect(extractText(file)).resolves.toBe('[Sheet: 资源清单]\n云资源名称\t生产环境\necs-001\t8')
  })

  it('preserves empty XLSX columns from sparse cell references', async () => {
    const zip = new JSZip()
    zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c><c r="C1" t="inlineStr"><is><t>规格</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>ecs-001</t></is></c><c r="C2"><v>8</v></c></row></sheetData></worksheet>`)
    const blob = await zip.generateAsync({ type: 'blob' })
    const file = new File([blob], '稀疏资源清单.xlsx', { type: inferFileMimeType('稀疏资源清单.xlsx') })

    await expect(extractText(file)).resolves.toBe('[Sheet: Sheet1]\n名称\t\t规格\necs-001\t\t8')
  })

  it('infers supported local document MIME types', () => {
    expect(inferFileMimeType('report.docx')).toContain('wordprocessingml')
    expect(inferFileMimeType('inventory.xlsx')).toContain('spreadsheetml')
    expect(inferFileMimeType('unknown.bin')).toBe('application/octet-stream')
  })
})
