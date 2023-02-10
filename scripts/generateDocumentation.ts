import glob  from 'glob'
import path, { ParsedPath } from 'path'
import { promises as fs } from 'fs';
import jsonld, { NodeObject, ValueObject } from 'jsonld';

const schemasWithFilePathById: Record<string, ParsedSchemaAndPath> = {};
const schemasWithFilePathByCategory: Record<string, ParsedSchemaAndPath[]> = {};

type Namespace<T extends string, TBase extends string> = {
  [key in T]: `${TBase}${key}`
};

function createNamespace<T extends string, TBase extends string>(
  baseUri: TBase,
  localNames: T[],
): Namespace<T, TBase> {
  return localNames.reduce((obj: Namespace<T, TBase>, localName): Namespace<T, TBase> => (
    { ...obj, [localName]: `${baseUri}${localName}` }
  // eslint-disable-next-line @typescript-eslint/prefer-reduce-type-parameter
  ), {} as Namespace<T, TBase>);
}

const RDFS = createNamespace('http://www.w3.org/2000/01/rdf-schema#', [
  'subClassOf',
  'label',
]);

const DCTERMS = createNamespace('http://purl.org/dc/terms/', [
  'description',
]);

const SHACL = createNamespace('http://www.w3.org/ns/shacl#', [
  'property',
  'name',
  'path',
  'class',
  'datatype',
  'NodeShape',
  'nodeKind'
]);

export const XSD = createNamespace('http://www.w3.org/2001/XMLSchema#', [
  'string',
]);

function capitalize(str: string): string {
  if (str.length == 0) {
    return str
  } else {
    return str.charAt(0).toUpperCase() + str.slice(1)
  }
}

function ensureArray<T>(arrayable: T | T[]): T[] {
  if (arrayable !== null && arrayable !== undefined) {
    return Array.isArray(arrayable) ? arrayable : [ arrayable ];
  }
  return [];
}

function getValueIfDefined<T>(fieldValue?: NodeObject[string]): T | undefined {
  if (fieldValue && Array.isArray(fieldValue)) {
    return fieldValue.map((valueItem) =>
      getValueIfDefined<T>(valueItem)!) as unknown as T;
  }
  if (fieldValue && typeof fieldValue === 'object') {
    return (fieldValue as ValueObject)['@value'] as unknown as T;
  }
  if (fieldValue !== undefined && fieldValue !== null) {
    return fieldValue as unknown as T;
  }
}

export function getIdIfDefined(nodeObject?: NodeObject | string): string | undefined {
  if (nodeObject && typeof nodeObject === 'object') {
    return nodeObject['@id'] as string;
  }
  if (nodeObject) {
    return nodeObject;
  }
}

interface ParsedSchemaAndPath {
  schema: NodeObject; 
  path: ParsedPath;
}

function linkToSchema(schema: NodeObject, relativeDepth: number) {
  const schemaWithFilePath = schemasWithFilePathById[schema['@id'] as string];
  if (schemaWithFilePath) {
    const paths = [schemaWithFilePath.path.dir];
    for (let i = 0; i < relativeDepth; i++) {
      paths.unshift('..');
    }
    return path.join(...paths);
  }
  return ''
}

function labelForSchemaAsLink(schema: NodeObject, relativeDepth: number) {
  return `[${getValueIfDefined(schema[RDFS.label]) || schema['@id']}](${linkToSchema(schema, relativeDepth)})`;
}

function labelForSchemaAsLinkWithId(schemaId: string, relativeDepth: number) {
  const schemaWithFilePath = schemasWithFilePathById[schemaId];
  return `[${getValueIfDefined(schemaWithFilePath.schema[RDFS.label]) || schemaWithFilePath.schema['@id']}](${linkToSchema(schemaWithFilePath.schema, relativeDepth)})`;
}

function propertyName(property: NodeObject) {
  return getValueIfDefined(property[SHACL.name]) ?? 
    getIdIfDefined(ensureArray<NodeObject>(property[SHACL.path] as NodeObject[])[0])
}

function propertyType(property: NodeObject, relativeDepth: number) {
  if (SHACL.class in property) {
    const value = getIdIfDefined(ensureArray<NodeObject>(property[SHACL.class] as NodeObject)[0]) ?? '';
    if (value in schemasWithFilePathById) {
      return labelForSchemaAsLinkWithId(value, relativeDepth);
    }
    return value;
  }
  if (SHACL.nodeKind in property) {
    return getIdIfDefined(ensureArray<NodeObject>(property[SHACL.nodeKind] as NodeObject)[0]) ?? ''
  }
  if (SHACL.datatype in property) {
    return getIdIfDefined(ensureArray<NodeObject>(property[SHACL.datatype] as NodeObject)[0]) ?? '';
  }
  return XSD.string;
}

function generateDocumentationPropertyRows(schema: NodeObject, relativeDepth: number): string {
  const parentClassesDocs = ensureArray<NodeObject>(schema[RDFS.subClassOf] as NodeObject[])
    .reduce((arr: string[], parent) => {
      const parentId = getIdIfDefined(parent);
      if (parentId && parentId in schemasWithFilePathById) {
        const parentSchema = schemasWithFilePathById[parentId].schema;
        arr.push(generateDocumentationPropertyRows(parentSchema, relativeDepth));
      }
      return arr
    }, [])
    .join('\n');

  const properties = ensureArray<NodeObject>(schema[SHACL.property] as NodeObject[]);
  const propertyDocs = properties
    .map((property) => (
      `| ${propertyName(property)} | ${propertyType(property, relativeDepth)} | |`
    ))
    .join('\n');
  
  const docs = [
    `### Properties from ${labelForSchemaAsLink(schema, relativeDepth)}`,
    '',
    '| name | Type | Description |',
    '| ---- | ---- | ----------- |',
    propertyDocs,
    '',
    parentClassesDocs
  ].join('\n');

  return docs;
}

async function generateDocumentationPropertySection(schema: NodeObject, relativeDepth: number): Promise<string> {
  return [
    '## Properties',
    '',
    generateDocumentationPropertyRows(schema, relativeDepth),
  ].join('\n');
}

function generateInheritanceHierarchy(schema: NodeObject, relativeDepth: number): string[] {
  const parentClassInheritances = ensureArray<NodeObject>(schema[RDFS.subClassOf] as NodeObject[])
    .reduce((arr: string[], parent) => {
      const parentId = getIdIfDefined(parent);
      if (parentId) {
        if (parentId in schemasWithFilePathById) {
          const parentSchema = schemasWithFilePathById[parentId].schema;
          arr = [ ...arr, ...generateInheritanceHierarchy(parentSchema, relativeDepth)];
        } else {
          arr.push(parentId);
        }
      }
      return arr
    }, []);
  
  let inheritanceStrings: string[] = [];
  if (parentClassInheritances.length > 0) {
    inheritanceStrings = parentClassInheritances.map((parentClassInheritance) => {
      return [
        parentClassInheritance,
        labelForSchemaAsLink(schema, relativeDepth),
      ].join(' > ');
    });
  } else {
    inheritanceStrings = [labelForSchemaAsLink(schema, relativeDepth)];
  }
  return inheritanceStrings;
}

function generateDocumentationHeader(schema: NodeObject, relativeDepth: number) {
  return [
    `# ${labelForSchemaAsLink(schema, relativeDepth)}`,
    '',
    'An SKL Schema',
    '',
    DCTERMS.description in schema ? getValueIfDefined(schema[DCTERMS.description]) : '',
    '',
    ...generateInheritanceHierarchy(schema, relativeDepth),
  ].join('\n');
}


async function generateDocumentationForFile(schema: NodeObject, relativeDepth: number): Promise<string> {
  return [
    '<!--- This is an autogenerated file -->',
    generateDocumentationHeader(schema, relativeDepth),
    '',
    await generateDocumentationPropertySection(schema, relativeDepth),
  ].join('\n');
}

function generateCategoryDocumentation() {
  return Object.entries(schemasWithFilePathByCategory).map(([category, schemasWithFilePath]) => (
    [
      `- [${capitalize(category)}](schemas/${category})`,
      schemasWithFilePath.map((schemaWithFilePath) => (
        `  - ${labelForSchemaAsLink(schemaWithFilePath.schema, 0)}`
      )).join('\n')
    ].join('\n')
  )).join('\n');
}

async function generateDocumentation() {
  const schemaFiles = glob.sync("**/schema.json");
  for (const filePath of schemaFiles) {
    const parsedFilePath = path.parse(filePath);
    const fileContents = await fs.readFile(filePath, { encoding: 'utf8' });
    const schema = JSON.parse(fileContents);
    const expandedSchema = (await jsonld.expand(schema))[0] as NodeObject;
    const schemaId = expandedSchema['@id'] as string
    schemasWithFilePathById[schemaId] = {
      path: parsedFilePath,
      schema: expandedSchema,
    }
  }

  for (const schemaWithFilePath of Object.values(schemasWithFilePathById)) {
    const splitPath = schemaWithFilePath.path.dir.split(path.sep)
    const fileDepth = splitPath.length;
    if (ensureArray<string>(schemaWithFilePath.schema['@type'] as string[]).includes(SHACL.NodeShape)) {
      const doc = await generateDocumentationForFile(schemaWithFilePath.schema, fileDepth);
      const readmePath = path.join(schemaWithFilePath.path.dir, 'README.md');
      await fs.writeFile(readmePath, doc);
    }
    const category = splitPath[splitPath.length - 2];
    if (category in schemasWithFilePathByCategory) {
      schemasWithFilePathByCategory[category].push(schemaWithFilePath);
    } else {
      schemasWithFilePathByCategory[category] = [ schemaWithFilePath ];
    }
  }

  const readmeContents = await fs.readFile('README.md', { encoding: 'utf8' });
  const indexOfIndex = readmeContents.indexOf('## Index');
  const newReadmeContents = [
    readmeContents.slice(0, indexOfIndex + 8),
    '',
    generateCategoryDocumentation(),
  ].join('\n');
  await fs.writeFile('README.md', newReadmeContents);
}

generateDocumentation();